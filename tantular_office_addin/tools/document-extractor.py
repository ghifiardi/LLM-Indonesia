#!/usr/bin/env python3
"""Tiny local document extractor for Tantular Deck Studio.

Runs a CORS-enabled localhost API that accepts multipart uploads and returns
plain text for TXT/MD/CSV, DOCX/PPTX/XLSX (stdlib zip/XML), and PDF when
either pypdf/PyPDF2 or pdftotext is available.

This intentionally stays local-only (127.0.0.1) for privacy.
"""
from __future__ import annotations

import argparse
import html
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Tuple
from xml.etree import ElementTree as ET

# Apple Vision OCR is optional and macOS-only. Guarded import so the server
# starts cleanly (and /api/ocr answers a clean 501) on Windows/Linux or when
# pyobjc-framework-Vision/Quartz are not installed.
try:
    import Vision  # type: ignore
    import Quartz  # type: ignore
    from Foundation import NSData  # type: ignore

    VISION_AVAILABLE = True
except ImportError:
    VISION_AVAILABLE = False

HOST = "127.0.0.1"
PORT = 8787
# 100 MB. This is a local-only helper (127.0.0.1) that reads the whole
# request body into memory in one shot (see do_POST below) — acceptable at
# this size for a single local developer/workshop process, but do not raise
# this further without switching to a streaming/chunked read.
MAX_BYTES = 100 * 1024 * 1024
MAX_MB_LABEL = MAX_BYTES // (1024 * 1024)

TEXT_EXTS = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log"}



def parse_multipart_file(content_type: str, body: bytes, field_name: str) -> tuple[str, bytes]:
    match = re.search(r"boundary=(?:\"([^\"]+)\"|([^;]+))", content_type or "", re.I)
    if not content_type.startswith("multipart/form-data") or not match:
        raise ValueError("Expected multipart/form-data with a file field")
    boundary = (match.group(1) or match.group(2)).strip()
    marker = b"--" + boundary.encode("utf-8")
    for part in body.split(marker):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        if b"\r\n\r\n" not in part:
            continue
        raw_headers, data = part.split(b"\r\n\r\n", 1)
        if data.endswith(b"\r\n"):
            data = data[:-2]
        headers = raw_headers.decode("utf-8", errors="replace")
        disp = next((line for line in headers.split("\r\n") if line.lower().startswith("content-disposition:")), "")
        if f'name="{field_name}"' not in disp and f"name={field_name}" not in disp:
            continue
        filename_match = re.search(r'filename="([^"]+)"|filename=([^;]+)', disp)
        if not filename_match:
            raise ValueError("Missing filename in file field")
        filename = os.path.basename((filename_match.group(1) or filename_match.group(2)).strip())
        if not filename:
            raise ValueError("Missing filename in file field")
        return filename, data
    raise ValueError("Missing file field")

def extract_text(filename: str, data: bytes) -> Tuple[str, str]:
    ext = Path(filename).suffix.lower()
    if ext in TEXT_EXTS:
        return decode_text(data), "text"
    if ext == ".docx":
        return extract_docx(data), "docx"
    if ext == ".pptx":
        return extract_pptx(data), "pptx"
    if ext == ".xlsx":
        return extract_xlsx(data), "xlsx"
    if ext == ".pdf":
        return extract_pdf(data), "pdf"
    raise ValueError(f"Unsupported file type: {ext or '(no extension)'}")


def decode_text(data: bytes) -> str:
    for enc in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def extract_docx(data: bytes) -> str:
    chunks = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = [n for n in z.namelist() if n.startswith("word/") and n.endswith(".xml")]
        # Prioritize body, then headers/footers/notes.
        names.sort(key=lambda n: (0 if n == "word/document.xml" else 1, n))
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        for name in names:
            if not re.search(r"word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$", name):
                continue
            try:
                root = ET.fromstring(z.read(name))
            except ET.ParseError:
                continue
            paras = []
            for p in root.findall(".//w:p", ns):
                texts = [t.text or "" for t in p.findall(".//w:t", ns)]
                para = "".join(texts).strip()
                if para:
                    paras.append(para)
            if paras:
                chunks.append("\n".join(paras))
    text = "\n\n".join(chunks).strip()
    if not text:
        raise ValueError("No extractable text found in DOCX")
    return text


def extract_pptx(data: bytes) -> str:
    """Extract visible-ish text from a PPTX, preserving slide order.

    The output includes both slide order and PowerPoint slide IDs from
    ppt/presentation.xml so the Office add-in can match the selected slide when
    the PowerPoint JS shape API cannot read grouped/complex text.
    """
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        slide_order = pptx_slide_order(z)
        if not slide_order:
            slide_order = sorted(
                [n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)],
                key=lambda n: int(re.search(r"slide(\d+)\.xml$", n).group(1)),
            )

        chunks = []
        for idx, slide_path in enumerate(slide_order, start=1):
            if slide_path not in z.namelist():
                continue
            try:
                root = ET.fromstring(z.read(slide_path))
            except ET.ParseError:
                continue
            texts = []
            # DrawingML text runs. This captures normal text boxes, grouped
            # shapes, tables, SmartArt text, and many chart labels.
            for node in root.iter():
                if node.tag.endswith("}t") and node.text:
                    value = node.text.strip()
                    if value:
                        texts.append(value)
            if texts:
                slide_id = pptx_slide_id_for_path(z, slide_path)
                label = f"[Slide {idx}{f' | id {slide_id}' if slide_id else ''}]"
                chunks.append(label + "\n" + "\n".join(compact_text_runs(texts)))

        text = "\n\n".join(chunks).strip()
        if not text:
            raise ValueError("No extractable text found in PPTX")
        return text


def pptx_slide_order(z: zipfile.ZipFile) -> list[str]:
    try:
        pres = ET.fromstring(z.read("ppt/presentation.xml"))
        rels = ET.fromstring(z.read("ppt/_rels/presentation.xml.rels"))
    except Exception:
        return []

    rel_map = {}
    for rel in rels:
        rid = rel.attrib.get("Id")
        target = rel.attrib.get("Target", "")
        if rid and target.startswith("slides/"):
            rel_map[rid] = "ppt/" + target

    order = []
    for node in pres.iter():
        if not node.tag.endswith("}sldId"):
            continue
        rid = node.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        if rid in rel_map:
            order.append(rel_map[rid])
    return order


def pptx_slide_id_for_path(z: zipfile.ZipFile, slide_path: str) -> str:
    try:
        pres = ET.fromstring(z.read("ppt/presentation.xml"))
        rels = ET.fromstring(z.read("ppt/_rels/presentation.xml.rels"))
    except Exception:
        return ""
    target_to_rid = {}
    for rel in rels:
        rid = rel.attrib.get("Id")
        target = rel.attrib.get("Target", "")
        if rid:
            target_to_rid["ppt/" + target if target.startswith("slides/") else target] = rid
    rid = target_to_rid.get(slide_path)
    if not rid:
        return ""
    for node in pres.iter():
        if not node.tag.endswith("}sldId"):
            continue
        node_rid = node.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        if node_rid == rid:
            return node.attrib.get("id", "")
    return ""


def compact_text_runs(texts: list[str]) -> list[str]:
    out = []
    last = ""
    for text in texts:
        clean = re.sub(r"\s+", " ", text).strip()
        if not clean or clean == last:
            continue
        out.append(clean)
        last = clean
    return out


XLSX_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
XLSX_REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


def extract_xlsx(data: bytes) -> str:
    """Extract cell text from an XLSX, sheet by sheet, in workbook order.

    Cells become tab-separated per row (reads as TSV), rows newline-
    separated, sheets labeled "[Sheet: Name]" — same spirit as extract_pptx's
    "[Slide N]" labels. A formula cell is read from its cached <v> result,
    never re-evaluated; a cell with no cached value (e.g. never opened/saved
    by Excel) is skipped rather than guessed at, same as everywhere else in
    this file: extract what is actually there, not what might be inferred.

    Old binary .xls is out of scope on purpose — it is not a zip/XML format
    at all (OLE2), unlike DOCX/PPTX/XLSX, and parsing it would need a real
    dependency this file otherwise avoids entirely.
    """
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        shared = xlsx_shared_strings(z)
        sheets = xlsx_sheet_order(z)
        if not sheets:
            sheets = [
                (Path(n).stem, n)
                for n in sorted(nn for nn in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", nn))
            ]

        chunks = []
        for name, path in sheets:
            if path not in z.namelist():
                continue
            try:
                root = ET.fromstring(z.read(path))
            except ET.ParseError:
                continue
            rows_out = []
            for row in root.findall(".//m:sheetData/m:row", XLSX_NS):
                cells = [xlsx_cell_text(cell, shared) for cell in row.findall("m:c", XLSX_NS)]
                # Trim trailing empty cells so a mostly-empty row doesn't turn
                # into a long tail of meaningless tabs.
                while cells and not cells[-1]:
                    cells.pop()
                if cells:
                    rows_out.append("\t".join(cells))
            if rows_out:
                chunks.append(f"[Sheet: {name}]\n" + "\n".join(rows_out))

        text = "\n\n".join(chunks).strip()
        if not text:
            raise ValueError("No extractable text found in XLSX")
        return text


def xlsx_shared_strings(z: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    try:
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    except ET.ParseError:
        return []
    out = []
    for si in root.findall("m:si", XLSX_NS):
        # A shared string can be one <t>, or several <r><t> rich-text runs —
        # concatenate the runs, same treatment as DOCX/PPTX text runs above.
        out.append("".join(t.text or "" for t in si.findall(".//m:t", XLSX_NS)))
    return out


def xlsx_sheet_order(z: zipfile.ZipFile) -> list[tuple[str, str]]:
    try:
        workbook = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    except Exception:
        return []
    rel_map = {}
    for rel in rels:
        rid = rel.attrib.get("Id")
        target = rel.attrib.get("Target", "")
        if rid:
            rel_map[rid] = target if target.startswith("xl/") else "xl/" + target.lstrip("/")
    order = []
    for sheet in workbook.findall(".//m:sheets/m:sheet", XLSX_NS):
        rid = sheet.attrib.get(f"{XLSX_REL_NS}id")
        name = sheet.attrib.get("name", "")
        if rid in rel_map:
            order.append((name, rel_map[rid]))
    return order


def xlsx_cell_text(cell: ET.Element, shared: list[str]) -> str:
    cell_type = cell.attrib.get("t", "")
    if cell_type == "s":
        v = cell.find("m:v", XLSX_NS)
        if v is None or not (v.text or "").strip():
            return ""
        try:
            return shared[int(v.text)]
        except (ValueError, IndexError):
            return ""
    if cell_type == "inlineStr":
        return "".join(t.text or "" for t in cell.findall(".//m:t", XLSX_NS))
    # Formula-result string ("str"), numeric, and boolean cells all carry
    # their value verbatim in <v> — just read it.
    v = cell.find("m:v", XLSX_NS)
    return v.text or "" if v is not None else ""


def extract_pdf(data: bytes) -> str:
    # Tracks whether any reader actually ran (no ImportError, no missing
    # binary) even if it came back with zero characters — that distinguishes
    # "nothing here can read a PDF" from "something read it, but the PDF has
    # no text layer" (a scan/screenshot flattened to images), which need
    # different, actionable error messages below.
    a_reader_ran = False

    # Try Python libraries if installed.
    for module_name in ("pypdf", "PyPDF2"):
        try:
            if module_name == "pypdf":
                from pypdf import PdfReader  # type: ignore
            else:
                from PyPDF2 import PdfReader  # type: ignore
            reader = PdfReader(io.BytesIO(data))
            a_reader_ran = True
            pages = []
            for i, page in enumerate(reader.pages):
                txt = ""
                # Layout mode preserves word spacing far better on many PDFs.
                try:
                    txt = page.extract_text(extraction_mode="layout") or ""
                except TypeError:
                    txt = page.extract_text() or ""
                except Exception:
                    try:
                        txt = page.extract_text() or ""
                    except Exception:
                        txt = ""
                if txt.strip():
                    pages.append(f"[Page {i+1}]\n{txt.strip()}")
            text = "\n\n".join(pages).strip()
            if text:
                return text
        except ImportError:
            pass

    # Try poppler pdftotext if available.
    pdftotext = shutil.which("pdftotext")
    if pdftotext:
        with tempfile.TemporaryDirectory() as td:
            pdf_path = Path(td) / "input.pdf"
            out_path = Path(td) / "output.txt"
            pdf_path.write_bytes(data)
            subprocess.run([pdftotext, "-layout", str(pdf_path), str(out_path)], check=True, timeout=60)
            a_reader_ran = True
            text = out_path.read_text(errors="replace").strip()
            if text:
                return text

    if a_reader_ran:
        # A real reader parsed this PDF successfully and still got no text
        # from any page — installing a library won't fix that, so don't
        # suggest it. This is the scanned/screenshot-PDF case: point the
        # user at the OCR path that actually handles it instead.
        raise ValueError(
            "PDF ini tampaknya berisi hasil scan/gambar tanpa teks yang bisa dibaca "
            "otomatis. Unggah tiap halaman sebagai gambar (PNG/JPG) di kolom "
            "'Sumber gambar/screenshot' untuk OCR, atau tempel teksnya secara manual."
        )

    raise ValueError(
        "PDF extraction requires pypdf/PyPDF2 or the pdftotext command. "
        "Install one, or paste/export text manually."
    )


def run_apple_vision_ocr(image_bytes: bytes) -> dict:
    """Run OCR over raw image bytes using the macOS Vision framework.

    Isolated behind the guarded import above so this is only ever called when
    VISION_AVAILABLE is True; still defensive internally since decode/OCR can
    fail on malformed images even when the framework itself is present.
    """
    if not VISION_AVAILABLE:
        return {"ok": False, "error": "Apple Vision tidak tersedia di sistem ini."}
    try:
        ns_data = NSData.dataWithBytes_length_(image_bytes, len(image_bytes))
        source = Quartz.CGImageSourceCreateWithData(ns_data, None)
        if source is None:
            return {"ok": False, "error": "Gagal membaca data gambar."}
        cg_image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None)
        if cg_image is None:
            return {"ok": False, "error": "Gagal decode gambar."}

        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, None)
        request = Vision.VNRecognizeTextRequest.alloc().init()
        request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        request.setRecognitionLanguages_(["id-ID", "en-US"])
        request.setUsesLanguageCorrection_(True)

        success, error = handler.performRequests_error_([request], None)
        if not success:
            return {"ok": False, "error": str(error) if error else "OCR request gagal."}

        lines = []
        for observation in request.results() or []:
            candidates = observation.topCandidates_(1)
            if not candidates:
                continue
            top = candidates[0]
            lines.append({"text": str(top.string()), "confidence": float(top.confidence())})

        text = "\n".join(line["text"] for line in lines)
        return {"ok": True, "text": text, "lines": lines}
    except Exception as exc:  # pragma: no cover - depends on live Vision runtime
        return {"ok": False, "error": str(exc)}


def clean_text(text: str, max_chars: int = 80_000) -> str:
    text = html.unescape(text)
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    text = text.strip()
    return text[:max_chars]


class Handler(BaseHTTPRequestHandler):
    server_version = "TantularDocExtractor/0.1"

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "service": "tantular-document-extractor"}).encode())
            return
        if self.path == "/api/ocr":
            if VISION_AVAILABLE:
                payload = {"ok": True, "engine": "apple-vision"}
                status = 200
            else:
                payload = {"ok": False, "error": "Apple Vision tidak tersedia (bukan macOS atau pyobjc belum terpasang)."}
                status = 501
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/ocr":
            self._handle_ocr_post()
            return
        if self.path != "/extract":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > MAX_BYTES:
                raise ValueError(f"File terlalu besar (maks {MAX_MB_LABEL} MB).")
            content_type = self.headers.get("Content-Type", "")
            body = self.rfile.read(length)
            filename, data = parse_multipart_file(content_type, body, "file")
            if len(data) > MAX_BYTES:
                raise ValueError(f"File terlalu besar (maks {MAX_MB_LABEL} MB).")
            text, kind = extract_text(filename, data)
            text = clean_text(text)
            payload = {
                "ok": True,
                "filename": filename,
                "kind": kind,
                "chars": len(text),
                "text": text,
            }
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        except Exception as exc:  # pragma: no cover - runtime path
            payload = {"ok": False, "error": str(exc)}
            self.send_response(400)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def _handle_ocr_post(self) -> None:
        if not VISION_AVAILABLE:
            payload = {"ok": False, "error": "Apple Vision tidak tersedia (bukan macOS atau pyobjc belum terpasang)."}
            self.send_response(501)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > MAX_BYTES:
                raise ValueError(f"File terlalu besar (maks {MAX_MB_LABEL} MB).")
            content_type = self.headers.get("Content-Type", "")
            body = self.rfile.read(length)
            _filename, data = parse_multipart_file(content_type, body, "file")
            if len(data) > MAX_BYTES:
                raise ValueError(f"File terlalu besar (maks {MAX_MB_LABEL} MB).")
            result = run_apple_vision_ocr(data)
            status = 200 if result.get("ok") else 400
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
        except Exception as exc:  # pragma: no cover - runtime path
            payload = {"ok": False, "error": str(exc)}
            self.send_response(400)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=HOST)
    ap.add_argument("--port", type=int, default=PORT)
    args = ap.parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Tantular document extractor listening at http://{args.host}:{args.port}")
    print("POST /extract with multipart field name 'file'. Ctrl+C to stop.")
    httpd.serve_forever()


if __name__ == "__main__":
    main()

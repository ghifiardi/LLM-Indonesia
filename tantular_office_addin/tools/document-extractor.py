#!/usr/bin/env python3
"""Tiny local document extractor for Tantular Deck Studio.

Runs a CORS-enabled localhost API that accepts multipart uploads and returns
plain text for TXT/MD/CSV, DOCX (stdlib zip/XML), and PDF when either pypdf/
PyPDF2 or pdftotext is available.

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

HOST = "127.0.0.1"
PORT = 8787
MAX_BYTES = 35 * 1024 * 1024

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


def extract_pdf(data: bytes) -> str:
    # Try Python libraries if installed.
    for module_name in ("pypdf", "PyPDF2"):
        try:
            if module_name == "pypdf":
                from pypdf import PdfReader  # type: ignore
            else:
                from PyPDF2 import PdfReader  # type: ignore
            reader = PdfReader(io.BytesIO(data))
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
            text = out_path.read_text(errors="replace").strip()
            if text:
                return text

    raise ValueError(
        "PDF extraction requires pypdf/PyPDF2 or the pdftotext command. "
        "Install one, or paste/export text manually."
    )


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
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/extract":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > MAX_BYTES:
                raise ValueError("File too large")
            content_type = self.headers.get("Content-Type", "")
            body = self.rfile.read(length)
            filename, data = parse_multipart_file(content_type, body, "file")
            if len(data) > MAX_BYTES:
                raise ValueError("File too large")
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

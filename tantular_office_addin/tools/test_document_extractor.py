#!/usr/bin/env python3
"""Tests for document-extractor.py's XLSX support.

Run: python3 tools/test_document_extractor.py

Builds real, minimal .xlsx files by hand with zipfile/stdlib (no openpyxl —
this file has no dependency beyond what document-extractor.py itself uses)
and runs the actual extraction functions against them: real input through the
real code path, not a fixture standing in for one. See the black-box
verification note in this repo's memory — a mocked/fixture-only check has
twice been narrower than the system it was meant to certify.
"""
from __future__ import annotations

import importlib.util
import io
import sys
import unittest
import zipfile
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parent / "document-extractor.py"
spec = importlib.util.spec_from_file_location("document_extractor", MODULE_PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def build_xlsx(sheets, shared=None, include_shared_strings=True):
    """sheets: list of (name, xml_body). shared: list of shared strings used
    by t="s" cells, referenced by index — matches how Excel actually writes
    repeated strings once and points cells at them."""
    shared = shared or []
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        "</Types>"
    )
    sheet_entries = "".join(
        f'<sheet name="{name}" sheetId="{i + 1}" r:id="rId{i + 1}"/>' for i, (name, _) in enumerate(sheets)
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<sheets>{sheet_entries}</sheets></workbook>"
    )
    rel_entries = "".join(
        f'<Relationship Id="rId{i + 1}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        f'Target="worksheets/sheet{i + 1}.xml"/>'
        for i in range(len(sheets))
    )
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f"{rel_entries}</Relationships>"
    )
    shared_strings = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        f'count="{len(shared)}" uniqueCount="{len(shared)}">'
        + "".join(f"<si><t>{s}</t></si>" for s in shared)
        + "</sst>"
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        if include_shared_strings:
            z.writestr("xl/sharedStrings.xml", shared_strings)
        for i, (_, body) in enumerate(sheets):
            z.writestr(
                f"xl/worksheets/sheet{i + 1}.xml",
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                f"<sheetData>{body}</sheetData></worksheet>",
            )
    return buf.getvalue()


class ExtractXlsxTests(unittest.TestCase):
    def test_shared_strings_inline_strings_and_cached_formula_result(self):
        sheet = (
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
            '<row r="2"><c r="A2" t="inlineStr"><is><t>Sewa venue</t></is></c>'
            '<c r="B2"><f>100+50</f><v>150</v></c></row>'
            '<row r="3"><c r="A3" t="inlineStr"><is><t>Konsumsi</t></is></c><c r="B3"><v>75</v></c></row>'
        )
        data = build_xlsx([("Anggaran", sheet)], shared=["Item", "Biaya"])
        text = mod.extract_xlsx(data)
        self.assertEqual(
            text,
            "[Sheet: Anggaran]\nItem\tBiaya\nSewa venue\t150\nKonsumsi\t75",
        )

    def test_multiple_sheets_stay_in_workbook_order(self):
        s1 = '<row r="1"><c r="A1" t="inlineStr"><is><t>satu</t></is></c></row>'
        s2 = '<row r="1"><c r="A1" t="inlineStr"><is><t>dua</t></is></c></row>'
        data = build_xlsx([("Pertama", s1), ("Kedua", s2)])
        text = mod.extract_xlsx(data)
        self.assertEqual(text.index("Pertama") < text.index("Kedua"), True)
        self.assertIn("satu", text)
        self.assertIn("dua", text)

    def test_trailing_empty_cells_are_trimmed(self):
        sheet = (
            '<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c>'
            '<c r="B1"/><c r="C1"/></row>'
        )
        data = build_xlsx([("Sheet1", sheet)])
        text = mod.extract_xlsx(data)
        self.assertEqual(text, "[Sheet: Sheet1]\nx")

    def test_truly_empty_workbook_raises_not_returns_blank(self):
        data = build_xlsx([("Kosong", "")])
        with self.assertRaises(ValueError):
            mod.extract_xlsx(data)

    def test_missing_shared_strings_part_does_not_crash(self):
        # A workbook with only inline/numeric cells has no need for
        # sharedStrings.xml, and Excel omits the part entirely in that case.
        sheet = '<row r="1"><c r="A1"><v>42</v></c></row>'
        data = build_xlsx([("Sheet1", sheet)], include_shared_strings=False)
        text = mod.extract_xlsx(data)
        self.assertEqual(text, "[Sheet: Sheet1]\n42")

    def test_out_of_range_shared_string_index_is_skipped_not_fatal(self):
        # A cell claims shared-string index 5 but the table only has 1 entry
        # — a corrupt-ish input should degrade to an empty cell, not crash
        # the whole extraction for the rest of a real user's workbook.
        sheet = (
            '<row r="1"><c r="A1" t="s"><v>5</v></c>'
            '<c r="B1" t="inlineStr"><is><t>tetap terbaca</t></is></c></row>'
        )
        data = build_xlsx([("Sheet1", sheet)], shared=["hanya satu"])
        text = mod.extract_xlsx(data)
        self.assertEqual(text, "[Sheet: Sheet1]\n\ttetap terbaca")

    def test_extract_text_dispatches_xlsx_extension(self):
        sheet = '<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row>'
        data = build_xlsx([("Sheet1", sheet)])
        text, kind = mod.extract_text("anggaran.xlsx", data)
        self.assertEqual(kind, "xlsx")
        self.assertEqual(text, mod.extract_xlsx(data))


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Lightweight manifest sanity check for the Tantular Office add-in.

This is not a replacement for Microsoft's schema validation, but it catches the
local mistakes that break sideloading most often: malformed XML, missing files
for localhost URLs, missing hosts, and missing required IDs.
"""
from __future__ import annotations

import pathlib
import re
import sys
import urllib.parse
import xml.etree.ElementTree as ET

NS = {
    "o": "http://schemas.microsoft.com/office/appforoffice/1.1",
    "bt": "http://schemas.microsoft.com/office/officeappbasictypes/1.0",
    "vo": "http://schemas.microsoft.com/office/taskpaneappversionoverrides",
}


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    raise SystemExit(1)


def warn(message: str) -> None:
    print(f"WARN: {message}")


def local_path_for_url(project_root: pathlib.Path, value: str) -> pathlib.Path | None:
    parsed = urllib.parse.urlparse(value)
    if parsed.hostname not in {"localhost", "127.0.0.1"}:
        return None
    if parsed.port not in {3000, None}:
        return None
    return project_root / urllib.parse.unquote(parsed.path.lstrip("/"))


def main() -> None:
    manifest = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "manifest.xml").resolve()
    project_root = manifest.parent
    if not manifest.exists():
        fail(f"manifest not found: {manifest}")

    try:
        tree = ET.parse(manifest)
    except ET.ParseError as exc:
        fail(f"XML parse error: {exc}")
    root = tree.getroot()

    addin_id = root.findtext("o:Id", namespaces=NS)
    if not addin_id or not re.fullmatch(r"[0-9a-fA-F-]{36}", addin_id):
        fail("missing or invalid Office add-in Id GUID")

    hosts = {host.attrib.get("Name") for host in root.findall("o:Hosts/o:Host", namespaces=NS)}
    expected = {"Document", "Workbook", "Presentation"}
    missing = expected - hosts
    if missing:
        fail(f"missing hosts: {', '.join(sorted(missing))}")

    source = root.find("o:DefaultSettings/o:SourceLocation", namespaces=NS)
    if source is None or not source.attrib.get("DefaultValue"):
        fail("missing DefaultSettings/SourceLocation")

    for elem in root.iter():
        value = elem.attrib.get("DefaultValue")
        if not value or not value.startswith(("https://localhost:3000/", "http://127.0.0.1:")):
            continue
        local = local_path_for_url(project_root, value)
        if local and not local.exists():
            fail(f"local URL points to missing file: {value} -> {local.relative_to(project_root)}")
        if value.startswith("http://") and "127.0.0.1" not in value:
            warn(f"non-HTTPS URL in manifest: {value}")

    print("OK: manifest.xml is well-formed and local references exist.")


if __name__ == "__main__":
    main()

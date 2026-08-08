# Tantular Sheet Studio

Sheet Studio is the Excel/XLSX counterpart to Deck Studio and Document Studio.
It converts a brief, pasted text, or selected Excel range into a structured
workbook using the local Tantular Office model.

## Sideload on Excel for Mac

```bash
npm run sideload:excel
```

Save open workbooks, then fully quit Excel with **Cmd+Q**. Closing only the
workbook window does not terminate Excel; local `wef` manifests are scanned at
application startup. Reopen Excel and use:

```text
Home → Tantular → Open Tantular
```

## Supported workbook types

- Tracker
- Data template
- Project plan
- Action plan
- Risk register
- Inventory
- Comparison matrix
- Survey / codebook

## Source priority

1. Text in the shared **Teks / seleksi** box
2. Current Excel range

## Output

The deterministic XLSX builder creates:

- one or more worksheets,
- sanitized and unique sheet names,
- consistent table columns and padded rows,
- typed plain numeric cells where safe,
- formatted header rows,
- wrapped body cells and calculated column widths,
- frozen top rows,
- optional notes beneath the table.

Users can write the result directly into new sheets, explicitly replace the
active sheet, or download a standalone `.xlsx`.

## Architecture

```text
Brief / pasted text / selected Excel range
  -> Tantular Office plans a normalized WorkbookSpec
  -> JSON mode + deterministic validation/fallback
  -> Excel.run writes sheets to the active workbook
  -> dependency-free OOXML builder provides .xlsx download
```

The model controls table structure and labels. Sheet-name safety, row widths,
missing-cell padding, package validity, XML escaping, and styling are
deterministic.

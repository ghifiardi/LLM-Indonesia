// Tantular Sheet Studio — normalized workbook spec → valid XLSX Base64.

import { escapeXml, zipBase64 } from "../shared/ooxmlZip.js";

export function buildWorkbookXlsxBase64(spec, options = {}) {
  if (!spec?.sheets?.length) throw new Error("WorkbookSpec tidak memiliki sheet.");
  const accent = hex(options.accent || "#1F3A5F");
  const sheets = spec.sheets;
  const files = new Map();
  files.set("[Content_Types].xml", contentTypes(sheets.length));
  files.set("_rels/.rels", rootRels());
  files.set("docProps/core.xml", coreXml(spec));
  files.set("docProps/app.xml", appXml(sheets));
  files.set("xl/workbook.xml", workbookXml(sheets));
  files.set("xl/_rels/workbook.xml.rels", workbookRels(sheets.length));
  files.set("xl/styles.xml", stylesXml(accent));
  sheets.forEach((sheet, index) => {
    files.set(`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet));
  });
  return zipBase64(files);
}

function worksheetXml(sheet) {
  const columns = sheet.columns || [];
  const width = columns.length || 1;
  const dataRows = sheet.rows || [];
  const colWidths = computeColumnWidths(columns, dataRows, width);

  const rowsXml = [];
  rowsXml.push(rowXml(1, columns.map((value) => cell(value, "s")), 1));
  dataRows.forEach((row, rIndex) => {
    const cells = [];
    for (let c = 0; c < width; c += 1) cells.push(cell(row[c] ?? ""));
    rowsXml.push(rowXml(rIndex + 2, cells));
  });

  const cols = `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`;
  const dimension = `A1:${columnLetter(width)}${dataRows.length + 1}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <dimension ref="${dimension}"/>
 <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
 <sheetFormatPr defaultRowHeight="15"/>
 ${cols}
 <sheetData>${rowsXml.join("")}</sheetData>
</worksheet>`;
}

function rowXml(index, cells, styleOverride) {
  return `<row r="${index}">${cells.map((c, i) => cellXml(columnLetter(i + 1) + index, c, styleOverride)).join("")}</row>`;
}

function cell(value, forceType) {
  const raw = value == null ? "" : String(value).trim();
  if (forceType === "s") return { type: "s", value: raw };
  if (raw !== "" && isPlainNumber(raw)) return { type: "n", value: raw.replace(/,/g, "") };
  return { type: "inlineStr", value: raw };
}

function cellXml(ref, c, styleOverride) {
  const style = styleOverride ? ` s="${styleOverride}"` : "";
  if (c.type === "s") {
    return `<c r="${ref}" s="1" t="inlineStr"><is><t xml:space="preserve">${escapeXml(c.value)}</t></is></c>`;
  }
  if (c.type === "n") {
    return `<c r="${ref}"${style}><v>${escapeXml(c.value)}</v></c>`;
  }
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(c.value)}</t></is></c>`;
}

function computeColumnWidths(columns, rows, width) {
  const widths = new Array(width).fill(10);
  for (let c = 0; c < width; c += 1) {
    let max = String(columns[c] ?? "").length;
    for (const row of rows) max = Math.max(max, String(row[c] ?? "").length);
    widths[c] = Math.min(60, Math.max(10, max + 2));
  }
  return widths;
}

function isPlainNumber(value) {
  return /^-?\d{1,15}(?:\.\d+)?$/.test(value) && !/^0\d/.test(value);
}

function columnLetter(index) {
  let n = index;
  let letter = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

function stylesXml(accent) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
 <fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF${accent}"/><bgColor indexed="64"/></patternFill></fill></fills>
 <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
 <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
 <cellXfs count="2">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
 </cellXfs>
 <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function contentTypes(sheetCount) {
  const sheets = Array.from({ length: sheetCount }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
 <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
 ${sheets}
 <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
 <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function rootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
 <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function workbookXml(sheets) {
  const sheetTags = sheets.map((sheet, i) => `<sheet name="${escapeXml(safeName(sheet.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <sheets>${sheetTags}</sheets>
</workbook>`;
}

function workbookRels(sheetCount) {
  const rels = Array.from({ length: sheetCount }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("");
  const styleId = sheetCount + 1;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 ${rels}
 <Relationship Id="rId${styleId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function appXml(sheets) {
  const titles = sheets.map((sheet, i) => `<vt:lpstr>${escapeXml(safeName(sheet.name, i))}</vt:lpstr>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
 <Application>Tantular Sheet Studio</Application>
 <TitlesOfParts><vt:vector size="${sheets.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts>
</Properties>`;
}

function coreXml(spec) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <dc:title>${escapeXml(spec.title)}</dc:title><dc:creator>Tantular Sheet Studio</dc:creator><cp:lastModifiedBy>Tantular</cp:lastModifiedBy>
 <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function safeName(name, index) {
  return String(name || `Sheet${index + 1}`).slice(0, 31) || `Sheet${index + 1}`;
}

function hex(color) {
  return String(color || "#1F3A5F").replace("#", "").toUpperCase();
}

// Tantular Document Studio — normalized document spec → valid DOCX Base64.

import { escapeXml, zipBase64 } from "../shared/ooxmlZip.js";

export function buildDocumentDocxBase64(spec, options = {}) {
  if (!spec?.title) throw new Error("DocumentSpec tidak memiliki judul.");
  const accent = hex(options.accent || "#A6351D");
  const files = new Map();
  files.set("[Content_Types].xml", contentTypes());
  files.set("_rels/.rels", rootRels());
  files.set("docProps/core.xml", coreXml(spec));
  files.set("docProps/app.xml", appXml());
  files.set("word/document.xml", documentXml(spec));
  files.set("word/_rels/document.xml.rels", documentRels());
  files.set("word/styles.xml", stylesXml(accent));
  files.set("word/numbering.xml", numberingXml(accent));
  files.set("word/settings.xml", settingsXml());
  return zipBase64(files);
}

function documentXml(spec) {
  const blocks = [];
  blocks.push(paragraph(spec.title, "Title"));
  if (spec.subtitle) blocks.push(paragraph(spec.subtitle, "Subtitle"));
  const meta = [spec.author, spec.date].filter(Boolean).join(" · ");
  if (meta) blocks.push(paragraph(meta, "Meta"));

  if (spec.executiveSummary?.length) {
    blocks.push(paragraph("Ringkasan Eksekutif", "Heading1"));
    spec.executiveSummary.forEach((item) => blocks.push(bullet(item)));
  }

  for (const section of spec.sections || []) {
    blocks.push(paragraph(section.heading || "Bagian", section.level === 2 ? "Heading2" : "Heading1"));
    (section.paragraphs || []).forEach((item) => blocks.push(paragraph(item, "Normal")));
    (section.bullets || []).forEach((item) => blocks.push(bullet(item)));
    if (section.quote) blocks.push(paragraph(section.quote, "Quote"));
  }

  if (spec.closing?.length) {
    blocks.push(paragraph("Kesimpulan & Langkah Berikutnya", "Heading1"));
    spec.closing.forEach((item) => blocks.push(bullet(item)));
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
  ${blocks.join("\n")}
  <w:sectPr>
   <w:pgSz w:w="12240" w:h="15840"/>
   <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
   <w:cols w:space="708"/>
   <w:docGrid w:linePitch="360"/>
  </w:sectPr>
 </w:body>
</w:document>`;
}

function paragraph(content, style = "Normal") {
  const lines = String(content || "").split(/\r?\n/);
  const runs = lines.map((line, index) => (
    `${index ? "<w:br/>" : ""}<w:t xml:space="preserve">${escapeXml(line)}</w:t>`
  )).join("");
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r>${runs}</w:r></w:p>`;
}

function bullet(content) {
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(content)}</w:t></w:r></w:p>`;
}

function stylesXml(accent) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:docDefaults>
  <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri"/><w:sz w:val="22"/><w:lang w:val="id-ID"/></w:rPr></w:rPrDefault>
  <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault>
 </w:docDefaults>
 <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
 <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Subtitle"/><w:pPr><w:spacing w:before="0" w:after="240"/><w:jc w:val="left"/></w:pPr><w:rPr><w:b/><w:color w:val="${accent}"/><w:sz w:val="42"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="180"/></w:pPr><w:rPr><w:color w:val="667085"/><w:sz w:val="26"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Meta"><w:name w:val="Meta"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="360"/></w:pPr><w:rPr><w:color w:val="667085"/><w:sz w:val="18"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="320" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="${accent}"/><w:sz w:val="32"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="344054"/><w:sz w:val="26"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="480"/><w:spacing w:before="120" w:after="200"/></w:pPr><w:rPr><w:i/><w:color w:val="475467"/><w:sz w:val="23"/></w:rPr></w:style>
 <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="160" w:line="280" w:lineRule="auto"/><w:ind w:left="720" w:hanging="360"/></w:pPr></w:style>
</w:styles>`;
}

function numberingXml(accent) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
 <w:abstractNum w:abstractNumId="0">
  <w:multiLevelType w:val="singleLevel"/>
  <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/>
   <w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr>
   <w:rPr><w:color w:val="${accent}"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr>
  </w:lvl>
 </w:abstractNum>
 <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
}

function contentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
 <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
 <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
 <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
 <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
 <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function rootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
 <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function documentRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
 <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>`;
}

function settingsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/></w:settings>`;
}

function coreXml(spec) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
 <dc:title>${escapeXml(spec.title)}</dc:title><dc:creator>${escapeXml(spec.author || "Tantular Document Studio")}</dc:creator>
 <cp:lastModifiedBy>Tantular</cp:lastModifiedBy>
 <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
 <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function appXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Tantular Document Studio</Application><AppVersion>1.0</AppVersion></Properties>`;
}

function hex(color) {
  return String(color || "#A6351D").replace("#", "").toUpperCase();
}

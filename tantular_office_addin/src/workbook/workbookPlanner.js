// Tantular Sheet Studio — brief/source text → normalized workbook spec.

import { runTantular } from "../tantularClient.js";

const WORKBOOK_SYSTEM = `Anda adalah Tantular Sheet Studio, perancang workbook Excel yang privat dan Indonesian-first.
Mode aktif: PRODUKTIVITAS SPREADSHEET, bukan keamanan/fraud.
Aturan:
- Jawab HANYA dengan satu objek JSON valid, tanpa markdown atau penjelasan.
- Rancang tabel yang benar-benar tabular: kolom konsisten dan setiap baris berisi record.
- Header kolom singkat dan jelas dalam Bahasa Indonesia (kecuali istilah teknis umum).
- Jangan mengarang angka, harga, tanggal, nama, atau data yang tidak ada di sumber.
- Jika angka contoh diperlukan, isi 0 atau kosong dan tandai lewat kolom "Catatan" bahwa data perlu diisi.
- Jangan menaruh paragraf panjang di dalam sel; pecah menjadi kolom yang tepat.
- Boleh membuat beberapa sheet bila topik memang membutuhkan tabel berbeda.`;

function workbookUser({ brief, workbookType, sheetCount, instruction }) {
  return `Susun workbook Excel dari brief/sumber berikut.

Jenis workbook: ${workbookType || "tracker/tabel data"}.
Jumlah sheet target: sekitar ${sheetCount}.
Instruksi tambahan: ${instruction || "tidak ada"}.

Skema JSON wajib:
{
  "title": "judul workbook",
  "sheets": [
    {
      "name": "nama sheet singkat (maks 28 karakter)",
      "description": "penjelasan singkat opsional",
      "columns": ["Header 1", "Header 2", "Header 3"],
      "rows": [
        ["nilai a1", "nilai b1", "nilai c1"],
        ["nilai a2", "nilai b2", "nilai c2"]
      ],
      "notes": ["catatan opsional tentang cara mengisi"]
    }
  ]
}

Setiap "rows" harus memiliki jumlah kolom yang sama dengan "columns".
Jika data faktual tidak tersedia, buat struktur kolom yang benar dan biarkan sel kosong daripada mengarang.

Brief/sumber:
"""${brief}"""`;
}

export async function planWorkbook({
  brief,
  workbookType = "Tracker",
  sheetCount = 2,
  instruction = "",
  signal
}) {
  const source = String(brief || "").trim();
  const count = clamp(sheetCount, 1, 8);
  if (!source) return { spec: null, source: "empty", error: "Sumber workbook kosong." };

  try {
    const raw = await runTantular({
      system: WORKBOOK_SYSTEM,
      user: workbookUser({ brief: source, workbookType, sheetCount: count, instruction }),
      maxTokens: Math.min(6000, 1400 + count * 700),
      temperature: 0.15,
      task: "workbook",
      jsonMode: true,
      signal
    });
    const parsed = extractJson(raw);
    if (parsed) return { spec: normalizeWorkbookSpec(parsed, source, count), source: "model" };
  } catch (error) {
    // A user's Cancel must stop the workflow, not degrade into a fallback
    // workbook that then gets built and written anyway.
    if (signal?.aborted) throw error;
    return {
      spec: fallbackWorkbookSpec(source, workbookType),
      source: "fallback",
      error: error?.message || String(error)
    };
  }
  return { spec: fallbackWorkbookSpec(source, workbookType), source: "fallback" };
}

export function normalizeWorkbookSpec(value, sourceText = "", sheetCount = 2) {
  const title = text(value?.title) || inferTitle(sourceText) || "Workbook Tantular";
  const normalized = (Array.isArray(value?.sheets) ? value.sheets : [])
    .map((sheet, index) => normalizeSheet(sheet, index))
    .filter((sheet) => sheet.columns.length)
    .slice(0, clamp(sheetCount, 1, 8));
  const sheets = uniqueSheetNames(normalized);
  return {
    title,
    sheets: sheets.length ? sheets : fallbackWorkbookSpec(sourceText, title).sheets
  };
}

function uniqueSheetNames(sheets) {
  const seen = new Set();
  return sheets.map((sheet) => {
    const base = sheet.name;
    let name = base;
    let suffix = 2;
    while (seen.has(name.toLowerCase())) {
      const tail = ` ${suffix}`;
      name = `${base.slice(0, Math.max(1, 28 - tail.length))}${tail}`;
      suffix += 1;
    }
    seen.add(name.toLowerCase());
    return { ...sheet, name };
  });
}

export function fallbackWorkbookSpec(sourceText, workbookType = "Workbook") {
  const lines = String(sourceText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50);
  return {
    title: inferTitle(sourceText) || workbookType || "Workbook Tantular",
    sheets: [{
      name: "Data",
      description: "Struktur dasar; lengkapi kolom sesuai kebutuhan.",
      columns: ["No", "Item", "Detail", "Status", "Catatan"],
      rows: lines.map((line, index) => [String(index + 1), truncate(line, 80), "", "", ""]),
      notes: ["Struktur fallback dibuat karena model tidak mengembalikan tabel yang valid."]
    }]
  };
}

function normalizeSheet(sheet, index = 0) {
  const columns = list(sheet?.columns).slice(0, 24);
  const width = columns.length;
  const rows = (Array.isArray(sheet?.rows) ? sheet.rows : [])
    .map((row) => {
      const cells = Array.isArray(row) ? row.map(cellText) : list(row);
      const padded = cells.slice(0, width);
      while (padded.length < width) padded.push("");
      return padded;
    })
    .filter((row) => row.some((cell) => cell !== ""))
    .slice(0, 500);
  return {
    name: sheetName(text(sheet?.name), index),
    description: text(sheet?.description),
    columns: width ? columns : [],
    rows,
    notes: list(sheet?.notes).slice(0, 6)
  };
}

function sheetName(name, index) {
  const cleaned = String(name || `Sheet${index + 1}`)
    .replace(/[\\/?*\[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28);
  return cleaned || `Sheet${index + 1}`;
}

function extractJson(raw) {
  const value = String(raw || "").trim();
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? value.slice(start, end + 1) : value;
  try {
    return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
  } catch {
    return null;
  }
}

function inferTitle(source) {
  const line = String(source || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean) || "";
  if (/^(buat|buatlah|susun|tulis|create|make)\b/i.test(line)) {
    const topic = line.match(/\b(?:tentang|mengenai|untuk)\s+(.+?)(?:[.;]|$)/i)?.[1];
    if (topic) return headline(topic);
  }
  return line.length <= 80 ? line : "";
}

function headline(value) {
  return String(value || "").trim().split(/\s+/)
    .map((word) => (word.length > 3 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ").slice(0, 80);
}

function cellText(value) {
  if (value == null) return "";
  if (typeof value === "number") return String(value);
  return String(value).replace(/\s+/g, " ").trim();
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function list(value) {
  if (Array.isArray(value)) return value.map(cellText).filter((item) => item !== "");
  if (typeof value === "string") return value.split(/\r?\n|,|\t/).map(cellText).filter(Boolean);
  return [];
}

function truncate(value, max) {
  const t = String(value || "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(Number(value) || min)));
}

// Turns the planner's JSON into what the Excel chat may show and do.
//
// 1. No success claims before Excel confirms: every change waits for a click,
//    so at plan time nothing has happened and any "chart sudah dibuat" in the
//    model's reply is false. Such sentences are removed before the reply is
//    displayed, spoken or kept in history.
// 2. Chart plans the validator would reject for an unrepresentable shape
//    (add_chart with "A:A,AA:AA,BF:BF", whole-column or misaligned series)
//    are repaired into a bounded add_series_chart ONLY when the live column
//    map proves the rows; otherwise the chat asks which rows to use. Nothing
//    is guessed and no internal tool error is shown.
// Pure and Office-free for unit tests.

import { resolvePlan } from "./excelClarify.js";
import {
  MAX_CHART_POINTS,
  MAX_CHART_SERIES,
  SERIES_CHART_TYPES,
  colName,
  parseRangeRef,
  sanitizeSeriesChart
} from "./excelSeriesChart.js";
import { sanitizeExcelActions } from "./excelTools.js";

// --- Success-claim guard ----------------------------------------------------

const CHANGE_WORDS = [
  "dibuat", "ditambahkan", "ditulis", "dipasang", "diubah", "diterapkan", "disisipkan", "diperbarui",
  "dihapus", "diisi", "diganti", "dimasukkan", "membuat", "menambahkan", "menulis", "memasang",
  "mengubah", "menerapkan", "menyisipkan", "memperbarui", "menghapus", "mengisi", "mengganti",
  "memasukkan", "siap", "jadi", "selesai", "tersedia"
].join("|");
const ENGLISH_CHANGE = "created|added|inserted|written|updated|applied|built|generated|made|done";
// A completion marker next to a change word is always a claim.
const STRONG_CLAIMS = [
  /✅/,
  new RegExp(`\\b(sudah|telah|berhasil|sukses)\\b.*\\b(${CHANGE_WORDS})\\b`, "i"),
  new RegExp(`\\b(I have|I've|has been|have been|was|were|successfully|is now|are now)\\b.*\\b(${ENGLISH_CHANGE})\\b`, "i")
];
// "Chart Line dibuat di ..." with no marker is a claim unless the sentence is
// future, conditional or negated ("akan dibuat setelah klik", "tidak dibuat").
const WEAK_CLAIM = /^(chart|grafik|diagram|sheet|formula|kolom|tabel|nilai|workbook)\b.*\b(dibuat|ditambahkan|ditulis|dipasang|diubah|diterapkan|disisipkan|diperbarui)\b/i;
const NOT_A_CLAIM = /\b(akan|setelah|jika|bila|kalau|klik|pratinjau|belum|tidak|gagal|bisa|dapat|perlu|will|after|once|click|not|cannot|can|could|would|should)\b/i;

function isChangeClaim(sentence) {
  const text = sentence.trim();
  if (STRONG_CLAIMS.some((re) => re.test(text))) return true;
  return WEAK_CLAIM.test(text) && !NOT_A_CLAIM.test(text);
}

export function stripChangeClaims(reply) {
  let removed = 0;
  const lines = String(reply ?? "").split("\n").map((line) => {
    const sentences = line.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
    const kept = sentences.filter((s) => {
      if (!isChangeClaim(s)) return true;
      removed += 1;
      return false;
    });
    return kept.join(" ");
  });
  return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

// The chat text for an acting plan. Rejected actions are counted, not quoted:
// their details are internal (op names, raw addresses) and go to the console.
export function composePlanAnswer({ reply, changesPending, rejectedCount = 0, notes = [] }) {
  const lines = [];
  const guarded = stripChangeClaims(reply).text;
  if (guarded) lines.push(guarded);
  else if (changesPending) lines.push("Pratinjau ada di bawah — workbook belum diubah.");
  lines.push(...notes);
  if (rejectedCount) lines.push(`⚠️ ${rejectedCount} aksi dalam rencana tidak valid sehingga tidak dijalankan.`);
  if (!changesPending && (rejectedCount || !lines.length)) lines.push("Tidak ada perubahan yang dibuat di workbook.");
  return lines.join("\n\n");
}

// --- Chart plan repair -------------------------------------------------------

const WHOLE_COLUMN_RE = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/;
const UNREADABLE = (parts) => (
  `Saya tidak bisa memastikan range chart dari "${parts.join(", ")}". Kolom dan baris mana yang dipakai untuk sumbu X `
  + "dan tiap seri (mis. A4:A62 untuk tanggal, AA4:AA62 untuk target)?"
);

// One comma part: { sheet, column, whole, r1?, r2? }, { multi } or null.
function parsePart(text) {
  let rest = String(text || "").trim();
  let sheet = "";
  const bang = rest.lastIndexOf("!");
  if (bang > 0) {
    sheet = rest.slice(0, bang).trim().replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
    rest = rest.slice(bang + 1).trim();
  }
  const whole = WHOLE_COLUMN_RE.exec(rest);
  if (whole) {
    if (whole[1].toUpperCase() !== whole[2].toUpperCase()) return { multi: true };
    return { sheet, column: whole[1].toUpperCase(), whole: true };
  }
  const ref = parseRangeRef(rest);
  if (!ref) return null;
  if (ref.c1 !== ref.c2) return { multi: true };
  return { sheet, column: colName(ref.c1), whole: false, r1: ref.r1, r2: ref.r2 };
}

function needsRepair(action) {
  if (action?.op === "add_chart") return String(action.dataAddress || action.address || "").includes(",");
  if (action?.op === "add_series_chart") return Boolean(sanitizeSeriesChart(action).error);
  return false;
}

function repairOne(action, ctx) {
  const ask = (question, options = []) => ({ clarify: { question, options } });
  const isChart = action.op === "add_chart";
  const parts = isChart
    ? String(action.dataAddress || action.address || "").split(",").map((p) => p.trim()).filter(Boolean)
    : [action.categories, ...(Array.isArray(action.series) ? action.series : []).map((s) => s?.values ?? s?.range)]
      .map((p) => String(p ?? "").trim());
  const givenNames = isChart ? [] : (action.series || []).map((s) => String(s?.name || "").trim());
  if (parts.length < 2 || parts.some((p) => !p)) return ask(UNREADABLE(parts));
  if (parts.length - 1 > MAX_CHART_SERIES) {
    return ask(`Satu chart memuat paling banyak ${MAX_CHART_SERIES} seri, sedangkan rencananya ${parts.length - 1}. Seri (kolom) mana saja yang dipakai?`);
  }
  const refs = parts.map(parsePart);
  if (refs.some((ref) => !ref || ref.multi)) return ask(UNREADABLE(parts));

  const sheets = new Set([action.sheet, ...refs.map((r) => r.sheet)].map((s) => String(s || "").trim()).filter(Boolean));
  if (sheets.size > 1) return ask(`Range chart menunjuk ke beberapa sheet (${[...sheets].join(", ")}). Semua data chart harus dari satu sheet; sheet mana yang dipakai?`);
  const sheet = [...sheets][0] || "";
  const active = String(ctx?.activeSheet || "");
  const onActive = !sheet || sheet.toLowerCase() === active.toLowerCase();
  const map = onActive ? ctx?.columnMap : null;
  const mapColumn = (letter) => map?.columns?.find((c) => c.column === letter) || null;
  const columnList = refs.map((r) => r.column).join(", ");

  const extents = [];
  for (const ref of refs) {
    if (!ref.whole) { extents.push({ r1: ref.r1, r2: ref.r2 }); continue; }
    if (!onActive) {
      return ask(`Isi kolom hanya terbaca untuk sheet aktif "${active}", jadi baris kolom ${columnList} di sheet "${sheet}" tidak bisa dipastikan. Baris mana yang dipakai (mis. ${ref.column}4:${ref.column}62)?`);
    }
    if (!map?.columns?.length) return ask(UNREADABLE(parts));
    if (map.rowsTruncated) {
      return ask(`Sheet ini lebih panjang dari ${map.rowsRead} baris yang terbaca, jadi baris akhir kolom ${columnList} tidak bisa dipastikan. Baris mana yang dipakai?`);
    }
    const col = mapColumn(ref.column);
    if (!col) return ask(`Kolom ${ref.column} tidak ditemukan di data sheet aktif. Kolom dan baris mana yang dimaksud?`);
    if (!col.numeric || !col.firstRow) {
      return ask(`Kolom ${ref.column}${col.header ? ` ("${col.header}")` : ""} tidak berisi angka atau tanggal yang terbaca, jadi barisnya tidak bisa dipastikan. Kolom dan baris mana yang dipakai?`);
    }
    extents.push({ r1: col.firstRow, r2: col.lastRow });
  }

  const aligned = extents.every((e) => e.r1 === extents[0].r1 && e.r2 === extents[0].r2);
  if (!aligned) {
    const lo = Math.max(...extents.map((e) => e.r1));
    const hi = Math.min(...extents.map((e) => e.r2));
    const listing = refs.map((r, i) => `${r.column}: baris ${extents[i].r1}–${extents[i].r2}`).join(", ");
    return ask(
      `Baris data tiap kolom tidak sama (${listing}), jadi chart tidak bisa dibuat tanpa menebak. Baris mana yang dipakai?`,
      hi >= lo ? [`Pakai baris ${lo}–${hi}`] : []
    );
  }
  const { r1, r2 } = extents[0];
  if (r2 - r1 + 1 > MAX_CHART_POINTS) {
    return ask(`Kolom ${columnList} berisi ${r2 - r1 + 1} baris, lebih dari batas ${MAX_CHART_POINTS} titik per chart. Rentang baris atau tanggal mana yang dipakai?`);
  }

  const [categoryRef, ...seriesRefs] = refs;
  const series = seriesRefs.map((ref, i) => ({
    name: givenNames[i] || mapColumn(ref.column)?.header || `Kolom ${ref.column}`,
    values: `${ref.column}${r1}:${ref.column}${r2}`
  }));
  const requested = String(action.type || "");
  const type = SERIES_CHART_TYPES.has(requested) ? requested : "Line";
  const repaired = {
    op: "add_series_chart",
    sheet,
    type,
    title: action.title,
    categories: `${categoryRef.column}${r1}:${categoryRef.column}${r2}`,
    series
  };
  if (sanitizeSeriesChart(repaired).error) return ask(UNREADABLE(parts));
  const notes = [
    `Rencana chart disesuaikan dari isi sheet: sumbu X ${repaired.categories}, `
    + `${series.map((s) => `${s.name} ${s.values}`).join(", ")}. Periksa pratinjau sebelum membuat chart.`
  ];
  if (requested && !SERIES_CHART_TYPES.has(requested)) {
    notes.push(`Tipe ${requested} tidak didukung untuk kolom terpisah; dipakai Line.`);
  }
  return { action: repaired, notes };
}

// Returns { actions, notes, clarify }. The first chart that cannot be repaired
// reliably turns the whole plan into a question (a plan that asks never acts).
export function repairChartActions(rawActions, ctx) {
  if (!Array.isArray(rawActions)) return { actions: rawActions, notes: [], clarify: null };
  const actions = [];
  const notes = [];
  for (const action of rawActions) {
    if (!needsRepair(action)) { actions.push(action); continue; }
    const result = repairOne(action, ctx);
    if (result.clarify) return { actions: rawActions, notes: [], clarify: result.clarify };
    actions.push(result.action);
    notes.push(...result.notes);
  }
  return { actions, notes, clarify: null };
}

// --- The whole turn ----------------------------------------------------------

// { kind: "act", actions, rejected, notes, text } or
// { kind: "clarify", question, options, text }. `text` is the only thing the
// chat may display, speak or remember for this turn.
export function interpretPlan(parsed, ctx) {
  let plan = resolvePlan(parsed);
  if (plan.kind === "act") {
    const repair = repairChartActions(plan.actions, ctx);
    if (!repair.clarify) {
      const { actions, rejected } = sanitizeExcelActions(repair.actions);
      return {
        kind: "act",
        actions,
        rejected,
        notes: repair.notes,
        text: composePlanAnswer({ reply: parsed?.reply, changesPending: actions.length > 0, rejectedCount: rejected.length, notes: repair.notes })
      };
    }
    plan = { kind: "clarify", ...repair.clarify };
  }
  const reply = stripChangeClaims(parsed?.reply).text;
  return {
    kind: "clarify",
    question: plan.question,
    options: plan.options,
    text: `${[reply, plan.question].filter(Boolean).join("\n\n")}\n\nWorkbook belum diubah. Jawab di sini, atau ketik "batal".`
  };
}

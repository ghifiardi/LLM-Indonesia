// Read the document a lookup will be verified against.
//
// This text is the SOURCE OF TRUTH for the answer check: protected strings are
// derived from it, and the approval token is bound to its hash. If it is empty
// or wrong, the verifier is checking against the wrong thing.
//
// It goes to the local companion ONLY. Nothing here builds a remote URL or a
// query; the query is composed separately from what the user typed. Keeping
// the reader ignorant of hosts means no future edit can accidentally put
// document text where the query goes.
//
//   Word         the body text — the whole document is what the user sees
//   Excel        the SELECTED range, because a workbook has no single body
//                and sending every sheet would be egress-by-accident if this
//                text ever reached anything but the companion
//   PowerPoint   the SELECTED slides' text, same reasoning
//
// Each reader fails with a reason rather than an empty string. "" would be
// indistinguishable from an empty document, and the caller would then send a
// lookup that could only be refused.

export const MAX_DOCUMENT_CHARS = 200_000;

function truncate(text) {
  const value = String(text || "");
  // Truncation changes the hash and the protected strings, so it is reported
  // rather than done silently: a user must not be told an answer was checked
  // against "the document" when it was checked against the first half.
  if (value.length <= MAX_DOCUMENT_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_DOCUMENT_CHARS), truncated: true };
}

async function readWord() {
  if (!globalThis.Word?.run) {
    return { ok: false, reason: "host_unavailable",
             message: "Word JavaScript API tidak tersedia." };
  }
  const text = await Word.run(async (context) => {
    const body = context.document.body;
    body.load("text");
    await context.sync();
    return body.text ?? "";
  });
  return { ok: true, source: "Word: seluruh isi dokumen", ...truncate(text) };
}

async function readExcel() {
  if (!globalThis.Excel?.run) {
    return { ok: false, reason: "host_unavailable",
             message: "Excel JavaScript API tidak tersedia." };
  }
  const result = await Excel.run(async (context) => {
    const range = context.workbook.getSelectedRange();
    range.load(["address", "values", "rowCount", "columnCount"]);
    await context.sync();
    const rows = [];
    for (let r = 0; r < (range.rowCount || 0); r += 1) {
      const cells = [];
      for (let c = 0; c < (range.columnCount || 0); c += 1) {
        cells.push(String(range.values?.[r]?.[c] ?? "").trim());
      }
      rows.push(cells.join(" | "));
    }
    return { address: range.address || "", body: rows.join("\n") };
  });
  if (!result.body.replace(/[|\s]/g, "")) {
    return { ok: false, reason: "empty_selection",
             message: "Pilih dulu range berisi data di Excel." };
  }
  return { ok: true, source: `Excel: seleksi ${result.address}`,
           ...truncate(`${result.address}\n${result.body}`) };
}

async function readPowerPoint() {
  if (!globalThis.PowerPoint?.run) {
    return { ok: false, reason: "host_unavailable",
             message: "PowerPoint JavaScript API tidak tersedia." };
  }
  const result = await PowerPoint.run(async (context) => {
    if (typeof context.presentation.getSelectedSlides !== "function") {
      return { unsupported: true };
    }
    const selected = context.presentation.getSelectedSlides();
    selected.load("items");
    await context.sync();
    const slides = selected.items || [];
    if (!slides.length) return { slides: [] };
    for (const slide of slides) {
      try { slide.shapes.load("items"); } catch { /* older hosts */ }
    }
    await context.sync();

    // Office proxy properties cannot be read just because their parent
    // collection was loaded. Queue each text range explicitly, sync once, then
    // read it. A hand-written mock that exposes `.text` eagerly hides this
    // requirement; real Office throws PropertyNotLoaded instead.
    const rangesBySlide = slides.map((slide) => {
      const ranges = [];
      for (const shape of slide.shapes?.items || []) {
        try {
          const range = shape.textFrame.textRange;
          range.load("text");
          ranges.push(range);
        } catch {
          // Images and other non-text shapes are expected and ignored.
        }
      }
      return ranges;
    });
    await context.sync();

    const texts = rangesBySlide.map((ranges, index) => {
      const lines = ranges
        .map((range) => String(range.text ?? "").trim())
        .filter(Boolean);
      return `Slide ${index + 1}\n${lines.join("\n")}`;
    });
    return { slides: texts };
  });

  if (result.unsupported) {
    return { ok: false, reason: "host_unavailable",
             message: "Host PowerPoint ini belum mendukung getSelectedSlides()." };
  }
  if (!result.slides.length) {
    return { ok: false, reason: "empty_selection",
             message: "Pilih dulu slide yang ingin diperiksa." };
  }
  const body = result.slides.join("\n\n");
  if (!body.replace(/Slide \d+/g, "").trim()) {
    return { ok: false, reason: "empty_selection",
             message: "Slide terpilih tidak memuat teks." };
  }
  return { ok: true, source: `PowerPoint: ${result.slides.length} slide terpilih`,
           ...truncate(body) };
}

export async function readLookupDocument(hostName) {
  const host = String(hostName || "").trim();
  let result;
  try {
    if (host === "Word") result = await readWord();
    else if (host === "Excel") result = await readExcel();
    else if (host === "PowerPoint") result = await readPowerPoint();
    else {
      return { ok: false, reason: "unsupported_host",
               message: `Pencarian belum didukung di ${host || "host ini"}.` };
    }
  } catch (error) {
    // An Office API that throws must not become an empty document: that would
    // send a lookup whose answer could only be refused.
    return { ok: false, reason: "read_failed",
             message: `Gagal membaca dokumen: ${error?.message || error}` };
  }
  if (result.ok && !String(result.text || "").trim()) {
    return { ok: false, reason: "empty_document",
             message: "Dokumen kosong; tidak ada yang bisa dipakai memeriksa jawaban." };
  }
  return result;
}

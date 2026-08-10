import { normalizeHostName } from "./prompts.js";

export async function getSelectionContext(hostName) {
  const host = normalizeHostName(hostName);
  if (host === "Excel" && globalThis.Excel) {
    try {
      return await getExcelSelection();
    } catch (error) {
      console.warn("Excel-specific selection failed; falling back to common API", error);
    }
  }
  const text = await getCommonSelectedText();
  return {
    host,
    text,
    meta: text ? `${host}: ${text.length} karakter dari seleksi.` : `${host}: seleksi kosong.`
  };
}

export async function insertResultText(hostName, text) {
  const host = normalizeHostName(hostName);
  if (!text.trim()) throw new Error("Tidak ada hasil untuk dimasukkan.");

  if (host === "Excel") {
    // Writing a 1×1 matrix into a multi-cell selection fails with a shape
    // mismatch ("data object is not compatible with the shape..."). Write to
    // the selection's top-left cell instead, whatever the selection size.
    if (globalThis.Excel?.run) {
      return Excel.run(async (context) => {
        const cell = context.workbook.getSelectedRange().getCell(0, 0);
        cell.values = [[text]];
        cell.format.wrapText = true;
        await context.sync();
        return "Hasil ditulis ke cell kiri-atas seleksi.";
      });
    }
    return setCommonSelectedData([[text]], Office.CoercionType.Matrix);
  }
  return setCommonSelectedData(text, Office.CoercionType.Text);
}

export async function writeExcelLabels(resultText) {
  if (!globalThis.Excel) {
    throw new Error("Fitur label range membutuhkan Excel JavaScript API.");
  }
  const labels = parseLabelLines(resultText);
  if (!labels.length) {
    throw new Error(
      "Tombol ini khusus untuk hasil KLASIFIKASI per baris (label 🛑/⚠️/✅ per cell). " +
      "Hasil saat ini berupa penjelasan biasa — gunakan \"Masukkan ke cell/range\" untuk menaruhnya di satu cell, " +
      "atau jalankan aksi cepat klasifikasi terlebih dahulu."
    );
  }

  return Excel.run(async (context) => {
    const selected = context.workbook.getSelectedRange();
    selected.load(["rowCount", "columnCount", "address"]);
    await context.sync();

    if (selected.columnCount !== 1) {
      throw new Error("Pilih satu kolom teks saja untuk klasifikasi per baris.");
    }
    if (selected.rowCount > 50) {
      throw new Error("MVP membatasi klasifikasi ke 50 baris per run.");
    }

    const output = labels.slice(0, selected.rowCount);
    while (output.length < selected.rowCount) output.push(["⚠️ Perlu dicek | Model tidak mengembalikan label untuk baris ini."]);

    const target = selected.getOffsetRange(0, 1).getResizedRange(selected.rowCount - 1, 0);
    target.values = output;
    target.format.autofitColumns();
    await context.sync();
    return `Menulis ${selected.rowCount} label di kolom sebelah kanan ${selected.address}.`;
  });
}

export async function writeWorkbookSpecToExcel(spec, mode = "new_sheets") {
  if (!globalThis.Excel?.run) {
    throw new Error("Fitur Sheet Studio membutuhkan Excel JavaScript API.");
  }
  if (!spec?.sheets?.length) throw new Error("WorkbookSpec kosong.");

  return Excel.run(async (context) => {
    const workbook = context.workbook;
    const existing = workbook.worksheets;
    existing.load("items/name");
    await context.sync();
    const usedNames = new Set((existing.items || []).map((sheet) => String(sheet.name).toLowerCase()));
    let firstOutput = null;

    for (let index = 0; index < spec.sheets.length; index += 1) {
      const sheetSpec = spec.sheets[index];
      let sheet;
      if (mode === "replace_active" && index === 0) {
        sheet = workbook.worksheets.getActiveWorksheet();
        const used = sheet.getUsedRangeOrNullObject();
        used.load("isNullObject");
        await context.sync();
        if (!used.isNullObject) used.clear("All");
      } else {
        const name = uniqueExcelSheetName(sheetSpec.name, usedNames);
        sheet = workbook.worksheets.add(name);
        usedNames.add(name.toLowerCase());
      }

      const columns = sheetSpec.columns || [];
      const rows = sheetSpec.rows || [];
      const values = [columns, ...rows.map((row) => {
        const cells = [...row].slice(0, columns.length);
        while (cells.length < columns.length) cells.push("");
        return cells;
      })];
      if (columns.length) {
        const range = sheet.getRangeByIndexes(0, 0, values.length, columns.length);
        range.values = values;
        range.format.wrapText = true;
        range.format.verticalAlignment = "Top";
        range.format.autofitColumns();
        range.format.autofitRows();

        const header = sheet.getRangeByIndexes(0, 0, 1, columns.length);
        header.format.fill.color = "#1F3A5F";
        header.format.font.color = "#FFFFFF";
        header.format.font.bold = true;
        header.format.rowHeight = 24;
        sheet.freezePanes.freezeRows(1);
      }

      if (sheetSpec.notes?.length && columns.length) {
        const noteStart = values.length + 1;
        const noteRange = sheet.getRangeByIndexes(noteStart, 0, sheetSpec.notes.length, 1);
        noteRange.values = sheetSpec.notes.map((note) => [`Catatan: ${note}`]);
        noteRange.format.font.italic = true;
        noteRange.format.font.color = "#667085";
      }
      if (!firstOutput) firstOutput = sheet;
    }

    firstOutput?.activate();
    await context.sync();
    return `${spec.sheets.length} sheet dibuat di workbook aktif.`;
  });
}

function uniqueExcelSheetName(requested, usedNames) {
  const base = String(requested || "Sheet")
    .replace(/[\\/?*\[\]:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28) || "Sheet";
  let name = base;
  let suffix = 2;
  while (usedNames.has(name.toLowerCase())) {
    const tail = ` ${suffix}`;
    name = `${base.slice(0, 31 - tail.length)}${tail}`;
    suffix += 1;
  }
  return name;
}

async function getExcelSelection() {
  return Excel.run(async (context) => {
    const range = context.workbook.getSelectedRange();
    range.load(["address", "values", "formulas", "rowCount", "columnCount"]);
    await context.sync();

    if (range.rowCount * range.columnCount > 50) {
      throw new Error("MVP membatasi seleksi Excel ke maksimum 50 cell. Pilih range yang lebih kecil.");
    }

    const rows = [];
    for (let r = 0; r < range.rowCount; r += 1) {
      const cells = [];
      for (let c = 0; c < range.columnCount; c += 1) {
        const formula = range.formulas?.[r]?.[c];
        const value = range.values?.[r]?.[c];
        cells.push(formula || value || "");
      }
      rows.push(cells.map((cell) => String(cell ?? "").trim()).join(" | "));
    }

    const numbered = rows.map((row, index) => `${index + 1}. ${row}`).join("\n");
    return {
      host: "Excel",
      text: numbered,
      meta: `Excel: ${range.address}, ${range.rowCount} baris × ${range.columnCount} kolom.`
    };
  });
}

function getCommonSelectedText() {
  return new Promise((resolve, reject) => {
    Office.context.document.getSelectedDataAsync(
      Office.CoercionType.Text,
      (result) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) {
          resolve(String(result.value || ""));
        } else {
          reject(new Error(result.error?.message || "Gagal membaca seleksi Office."));
        }
      }
    );
  });
}

function setCommonSelectedData(data, coercionType) {
  return new Promise((resolve, reject) => {
    Office.context.document.setSelectedDataAsync(
      data,
      { coercionType },
      (result) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) {
          resolve("Hasil dimasukkan ke seleksi aktif.");
        } else {
          reject(new Error(result.error?.message || "Gagal memasukkan hasil ke Office."));
        }
      }
    );
  });
}

function parseLabelLines(resultText) {
  return String(resultText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\d+[.)]\s*/, ""))
    .filter((line) => /^(🛑|⚠️|✅)/u.test(line))
    .map((line) => [line]);
}


export async function getSelectedSlideTextContext() {
  if (!globalThis.PowerPoint?.run) {
    return fallbackSelectedTextContext("PowerPoint JavaScript API tidak tersedia.");
  }

  try {
    return await PowerPoint.run(async (context) => {
      if (typeof context.presentation.getSelectedSlides !== "function") {
        return fallbackSelectedTextContext("Host PowerPoint ini belum mendukung getSelectedSlides().");
      }

      const selectedSlides = context.presentation.getSelectedSlides();
      selectedSlides.load("items");
      await context.sync();

      const slides = selectedSlides.items || [];
      if (!slides.length) {
        return fallbackSelectedTextContext("Tidak ada slide terpilih.");
      }

      for (const slide of slides) {
        try { slide.shapes.load("items"); } catch (_) { /* ignore */ }
        try { slide.load("id"); } catch (_) { /* ignore */ }
      }
      await context.sync();

      const slideIds = slides.map((slide) => String(slide.id || "")).filter(Boolean);
      const slideIndexes = [];
      try {
        const allSlides = context.presentation.slides;
        allSlides.load("items");
        await context.sync();
        for (const slide of allSlides.items || []) {
          try { slide.load("id"); } catch (_) { /* ignore */ }
        }
        await context.sync();
        const idToIndex = new Map((allSlides.items || [])
          .map((slide, index) => [String(slide.id || ""), index + 1])
          .filter(([id]) => id));
        for (const id of slideIds) {
          const index = idToIndex.get(id);
          if (index) slideIndexes.push(index);
        }
      } catch (_) {
        // Older PowerPoint hosts may not expose presentation.slides. The
        // fallback path can still use slide IDs or an explicit page number.
      }

      const ranges = [];
      for (const slide of slides) {
        for (const shape of slide.shapes?.items || []) {
          try {
            const range = shape.textFrame.textRange;
            range.load("text");
            ranges.push(range);
          } catch (_) {
            // Non-text shapes/images are expected and ignored.
          }
        }
      }
      await context.sync();

      const text = ranges
        .map((range) => String(range.text || "").trim())
        .filter(Boolean)
        .join("\n");

      if (text) {
        return {
          host: "PowerPoint",
          text,
          meta: `PowerPoint: ${slides.length} slide terpilih, ${text.length} karakter teks terbaca.`,
          slideIds,
          slideIndexes
        };
      }

      return {
        host: "PowerPoint",
        text: "",
        meta: "Slide terpilih tidak memiliki teks terbaca melalui shape API.",
        slideIds,
        slideIndexes
      };
    });
  } catch (error) {
    console.warn("Selected-slide text extraction failed", error);
    return fallbackSelectedTextContext(error?.message || String(error));
  }
}

export async function getActivePresentationPptxFile() {
  if (!globalThis.Office?.context?.document?.getFileAsync) {
    throw new Error("Office file API tidak tersedia untuk membaca deck aktif.");
  }
  const file = await getOfficeFileAsync(Office.FileType.Compressed);
  try {
    const chunks = [];
    for (let i = 0; i < file.sliceCount; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const slice = await getOfficeSliceAsync(file, i);
      chunks.push(new Uint8Array(slice.data));
    }
    const blob = new Blob(chunks, { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
    return new File([blob], "active-presentation.pptx", { type: blob.type });
  } finally {
    try { file.closeAsync(); } catch (_) { /* ignore */ }
  }
}

function getOfficeFileAsync(fileType) {
  return new Promise((resolve, reject) => {
    Office.context.document.getFileAsync(
      fileType,
      { sliceSize: 4 * 1024 * 1024 },
      (result) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) {
          resolve(result.value);
        } else {
          reject(new Error(result.error?.message || "Gagal membaca file PowerPoint aktif."));
        }
      }
    );
  });
}

function getOfficeSliceAsync(file, index) {
  return new Promise((resolve, reject) => {
    file.getSliceAsync(index, (result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) {
        resolve(result.value);
      } else {
        reject(new Error(result.error?.message || `Gagal membaca slice deck aktif ${index}.`));
      }
    });
  });
}

// Insert a generated .pptx (base64) directly into the active presentation so
// the user can preview the deck without downloading. Requires PowerPointApi 1.2
// (insertSlidesFromBase64); callers should fall back to download on failure.
export async function insertDeckIntoActivePresentation(base64, options = {}) {
  if (!globalThis.PowerPoint?.run) {
    throw new Error("PowerPoint JavaScript API tidak tersedia. Buka pane ini di PowerPoint.");
  }
  await PowerPoint.run(async (context) => {
    if (typeof context.presentation.insertSlidesFromBase64 !== "function") {
      throw new Error("Host PowerPoint ini belum mendukung insertSlidesFromBase64.");
    }
    const insertOptions = {
      formatting: options.formatting || "KeepSourceFormatting"
    };
    if (options.targetSlideId) insertOptions.targetSlideId = options.targetSlideId;

    context.presentation.insertSlidesFromBase64(base64, insertOptions);
    await context.sync();
  });
}

// Replace one slide in the active presentation with the slide(s) from a
// generated .pptx: insert after the target, then delete the original so the
// improved version takes the SAME position instead of piling up as extra
// pages. Falls back gracefully when the host cannot identify or delete the
// original (delete needs PowerPointApi 1.3).
export async function replaceSlideInActivePresentation(base64, { slideId = "", slideIndex = 0, formatting = "UseDestinationTheme" } = {}) {
  if (!globalThis.PowerPoint?.run) {
    throw new Error("PowerPoint JavaScript API tidak tersedia. Buka pane ini di PowerPoint.");
  }
  return PowerPoint.run(async (context) => {
    if (typeof context.presentation.insertSlidesFromBase64 !== "function") {
      throw new Error("Host PowerPoint ini belum mendukung insertSlidesFromBase64.");
    }

    // Slide ids appear as "257" (common API / insert target) or
    // "257#creationId" (modern API); compare on the numeric part.
    const sameSlideId = (a, b) => String(a || "").split("#")[0] === String(b || "").split("#")[0];

    // Resolve the target slide id: prefer the explicit id, else map a 1-based
    // index through the live slide collection.
    let targetId = String(slideId || "");
    let slides = null;
    try {
      slides = context.presentation.slides;
      slides.load("items");
      await context.sync();
      for (const slide of slides.items || []) {
        try { slide.load("id"); } catch (_) { /* ignore */ }
      }
      await context.sync();
      if (!targetId && slideIndex > 0) {
        const byIndex = (slides.items || [])[slideIndex - 1];
        targetId = String(byIndex?.id || "");
      }
    } catch (_) {
      // Older hosts may not expose presentation.slides; keep whatever id we have.
    }

    if (!targetId) {
      // No safe anchor: refuse rather than dropping the slide at the top of
      // the deck, which reads as corruption to the user.
      throw new Error(
        "PowerPoint tidak mengekspos ID slide terpilih, jadi Tantular tidak bisa menentukan posisi yang benar. " +
        "Klik langsung slide-nya di panel thumbnail lalu coba lagi, atau tulis \"slide #N\" di kotak instruksi."
      );
    }

    context.presentation.insertSlidesFromBase64(base64, { formatting, targetSlideId: targetId });
    await context.sync();

    // Delete the original so the improved slide takes its place. Re-read the
    // collection AFTER the insert — pre-insert proxies can go stale.
    try {
      const fresh = context.presentation.slides;
      fresh.load("items");
      await context.sync();
      for (const slide of fresh.items || []) {
        try { slide.load("id"); } catch (_) { /* ignore */ }
      }
      await context.sync();
      const original = (fresh.items || []).find((slide) => sameSlideId(slide.id, targetId));
      if (!original) {
        return { replaced: false, reason: "Slide asli tidak ditemukan lagi setelah insert." };
      }
      if (typeof original.delete !== "function") {
        return { replaced: false, reason: "Host PowerPoint ini belum mendukung penghapusan slide via API (butuh PowerPointApi 1.3)." };
      }
      original.delete();
      await context.sync();
      return { replaced: true };
    } catch (deleteError) {
      return { replaced: false, reason: deleteError?.message || String(deleteError) };
    }
  });
}

// Common-API selection info: works on hosts WITHOUT PowerPointApi 1.5
// getSelectedSlides() (e.g. older desktop builds). Returns 1-based indexes and
// numeric slide ids (the {id} part accepted by insertSlidesFromBase64).
export function getSelectedSlideRangeCommon() {
  return new Promise((resolve) => {
    const empty = { slideIds: [], slideIndexes: [] };
    try {
      Office.context.document.getSelectedDataAsync(Office.CoercionType.SlideRange, (result) => {
        const slides = result?.status === Office.AsyncResultStatus.Succeeded ? result.value?.slides : null;
        if (Array.isArray(slides) && slides.length) {
          resolve({
            slideIds: slides.map((s) => String(s.id ?? "")).filter(Boolean),
            slideIndexes: slides.map((s) => Number(s.index) || 0).filter(Boolean)
          });
        } else {
          resolve(empty);
        }
      });
    } catch (_) {
      resolve(empty);
    }
  });
}

async function fallbackSelectedTextContext(reason) {
  // Even when slide text/ids are unreadable through the modern API, the common
  // API usually still knows WHICH slide is selected — enough for the extractor
  // fallback and in-place replacement to target the right page.
  const range = await getSelectedSlideRangeCommon();
  try {
    const text = await getCommonSelectedText();
    if (text.trim()) {
      return {
        host: "PowerPoint",
        text,
        meta: `PowerPoint: ${text.length} karakter dari seleksi aktif. (${reason})`,
        // Text selection is usually a FRAGMENT of the slide, not the whole
        // slide; callers that need full-slide context should re-read it.
        partialSelection: true,
        ...range
      };
    }
  } catch (_) {
    // ignore fallback failure
  }
  return {
    host: "PowerPoint",
    text: "",
    meta: `Tidak dapat membaca isi slide otomatis. ${reason}`,
    ...range
  };
}

// Main body ONLY: body.text excludes headers, footers, footnotes, text
// boxes, and comments. UI must say "Dokumen (isi utama)".
export async function getDocumentBodyText() {
  if (!globalThis.Word) throw new Error("Fitur ini membutuhkan Word JavaScript API.");
  return Word.run(async (context) => {
    const body = context.document.body;
    body.load("text");
    await context.sync();
    return body.text ?? "";
  });
}

// Insert a complete generated DOCX into the active Word document. Append is the
// safe default so existing user content is never destroyed implicitly.
export async function insertDocxIntoWord(base64, mode = "append") {
  if (!globalThis.Word?.run) {
    // Word disables its JS API entirely for documents opened in
    // "Compatibility Mode" — the most common reason this branch fires.
    throw new Error(
      "Word JavaScript API tidak tersedia. Jika judul jendela menampilkan \"Compatibility Mode\", " +
      "konversi dulu dokumennya: File → Convert Document (atau Save As format .docx modern), " +
      "tutup dan buka kembali, lalu coba lagi."
    );
  }
  if (!base64) throw new Error("File DOCX kosong.");
  return Word.run(async (context) => {
    const body = context.document.body;
    const location = mode === "replace"
      ? (Word.InsertLocation?.replace || "Replace")
      : (Word.InsertLocation?.end || "End");
    if (typeof body.insertFileFromBase64 !== "function") {
      throw new Error("Versi Word ini belum mendukung insertFileFromBase64. Gunakan Download .docx.");
    }
    body.insertFileFromBase64(base64, location);
    await context.sync();
    return mode === "replace"
      ? "Dokumen Word diganti dengan hasil Document Studio."
      : "Dokumen hasil Document Studio ditambahkan ke akhir file Word.";
  });
}

export function markdownToWordBlocks(markdown) {
  const blocks = [];
  for (const rawLine of String(markdown || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^---+$/.test(line)) continue;
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: Math.min(3, heading[1].length),
        text: stripInlineMarkdown(heading[2])
      });
      continue;
    }
    const bullet = line.match(/^[-•]\s+(.+)$/);
    if (bullet) {
      blocks.push({ type: "bullet", text: stripInlineMarkdown(bullet[1]) });
      continue;
    }
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      blocks.push({ type: "number", text: stripInlineMarkdown(numbered[1]) });
      continue;
    }
    blocks.push({ type: "paragraph", text: stripInlineMarkdown(line) });
  }
  return blocks;
}

// Paragraph.styleBuiltIn requires WordApi 1.3; assigning it on older hosts
// (e.g. some Word for Mac builds) makes context.sync() fail with
// InvalidArgument, the same way ParagraphCollection.getLast() does.
function supportsBuiltInStyles() {
  return globalThis.Office?.context?.requirements?.isSetSupported?.("WordApi", "1.3") ?? false;
}

// Insert markdown (e.g. a generated table) at the current selection as real
// Word content via insertHtml (WordApi 1.1). mode "after" keeps the selected
// text and adds the content right after it; mode "replace" swaps the selected
// text for the content. "After" is rejected by some hosts for Range targets;
// "End" lands visually in the same place.
export async function insertMarkdownAtSelection(markdown, mode = "after") {
  if (!globalThis.Word?.run) {
    throw new Error(
      "Word JavaScript API tidak tersedia. Jika judul jendela menampilkan \"Compatibility Mode\", " +
      "konversi dulu dokumennya lewat File → Convert Document, lalu coba lagi."
    );
  }
  const html = markdownToWordHtml(markdown);
  return Word.run(async (context) => {
    const selection = context.document.getSelection();
    const replace = Word.InsertLocation?.replace || "Replace";
    const after = Word.InsertLocation?.after || "After";
    const end = Word.InsertLocation?.end || "End";
    const attempts = mode === "replace" ? [replace] : [after, end];
    let lastError = null;
    for (const location of attempts) {
      try {
        selection.insertHtml(html, location);
        await context.sync();
        return mode === "replace"
          ? "Teks yang di-highlight diganti dengan tabel."
          : "Tabel disisipkan tepat setelah teks yang di-highlight.";
      } catch (error) {
        lastError = error;
        console.warn(`[Tantular] insertHtml(${location}) pada seleksi ditolak host.`, error, error?.debugInfo);
      }
    }
    throw new Error(lastError?.message || "Host menolak penyisipan HTML pada seleksi.");
  });
}

// Convert chat markdown into HTML for Range/Body.insertHtml (WordApi 1.1).
// This yields real Word tables, headings, and lists even on hosts that reject
// the WordApi 1.3 styleBuiltIn API.
export function markdownToWordHtml(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const isTableLine = (line) => /^\|.*\|$/.test(line);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || /^---+$/.test(line)) { closeList(); continue; }

    if (isTableLine(line)) {
      closeList();
      const tableLines = [];
      while (i < lines.length && isTableLine(lines[i].trim())) {
        tableLines.push(lines[i].trim());
        i += 1;
      }
      i -= 1;
      out.push(markdownTableToHtml(tableLines));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length);
      out.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^[-•]\s+(.+)$/);
    if (bullet) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inlineMarkdownToHtml(bullet[1])}</li>`);
      continue;
    }
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inlineMarkdownToHtml(numbered[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inlineMarkdownToHtml(line)}</p>`);
  }
  closeList();
  return out.join("");
}

function markdownTableToHtml(tableLines) {
  const parseRow = (line) => line.slice(1, -1).split("|").map((cell) => cell.trim());
  const isSeparator = (cells) => cells.every((cell) => /^:?-{2,}:?$/.test(cell));
  const rows = tableLines.map(parseRow).filter((cells) => cells.length && !isSeparator(cells));
  if (!rows.length) return "";
  const hasHeader = tableLines.length >= 2 && isSeparator(parseRow(tableLines[1]));
  const cellStyle = 'style="border:1pt solid #8a8a8a;padding:3pt 6pt"';
  const cell = (tag, text) => `<${tag} ${cellStyle}>${inlineMarkdownToHtml(text)}</${tag}>`;
  const html = [];
  html.push('<table style="border-collapse:collapse" border="1">');
  rows.forEach((cells, index) => {
    const tag = hasHeader && index === 0 ? "th" : "td";
    html.push(`<tr>${cells.map((text) => cell(tag, text)).join("")}</tr>`);
  });
  html.push("</table>");
  return html.join("");
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMarkdownToHtml(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1");
}

function styleWordParagraph(paragraph, block) {
  if (block.type === "heading") {
    const styles = [
      Word.BuiltInStyleName?.heading1 || "Heading1",
      Word.BuiltInStyleName?.heading2 || "Heading2",
      Word.BuiltInStyleName?.heading3 || "Heading3"
    ];
    paragraph.styleBuiltIn = styles[block.level - 1];
  } else if (block.type === "bullet") {
    paragraph.styleBuiltIn = Word.BuiltInStyleName?.listBullet || "ListBullet";
  } else if (block.type === "number") {
    paragraph.styleBuiltIn = Word.BuiltInStyleName?.listNumber || "ListNumber";
  }
}

// WordApi 1.1 fallback: direct character formatting plus literal list markers.
function formatWordParagraphBasic(paragraph, block) {
  if (block.type === "heading") {
    paragraph.font.bold = true;
    paragraph.font.size = [16, 14, 12][block.level - 1] || 12;
  }
}

function basicBlockText(block, listIndex) {
  if (block.type === "bullet") return `• ${block.text}`;
  if (block.type === "number") return `${listIndex}. ${block.text}`;
  return block.text;
}

// Keep in sync with the tag shown in src/taskpane.html next to the chat title.
export const TASKPANE_BUILD = "b0810b";

// Insert a formatted answer. When `afterText` is provided and located, the
// content is placed immediately after that anchor (end of the queried
// subsection). Callers can disable the end-of-document fallback when they
// offer a separate explicit append action.
export async function insertStructuredTextIntoWord(
  markdown,
  { afterText = "", fallbackToEnd = true } = {}
) {
  if (!globalThis.Word?.run) throw new Error("Fitur ini membutuhkan Word JavaScript API.");
  const blocks = markdownToWordBlocks(markdown);
  if (!blocks.length) throw new Error("Jawaban kosong; tidak ada yang bisa dimasukkan.");
  const anchor = String(afterText || "").trim().slice(0, 255);

  return Word.run(async (context) => {
    const body = context.document.body;

    let cursor = null;
    let placement = "akhir dokumen";
    if (anchor) {
      const search = body.search(anchor, { matchCase: false, ignoreSpace: true });
      search.load("items");
      await context.sync();
      if (search.items.length) {
        // Keep the search result as a Range. ParagraphCollection.getLast()
        // requires WordApi 1.3 and can raise InvalidArgument on older Word for
        // Mac hosts, while Range/Paragraph.insertParagraph are WordApi 1.1.
        // Anchor at the FIRST occurrence: duplicates of the anchor text (e.g.
        // answers previously appended at the end) always come later.
        cursor = search.items[0];
        placement = "setelah sub-section terkait";
      } else if (!fallbackToEnd) {
        throw new Error(
          "Lokasi sub-section tidak ditemukan lagi. Dokumen mungkin sudah berubah; kirim ulang pertanyaan atau gunakan “Tambahkan ke akhir dokumen”."
        );
      }
    }

    const outcome = await writeAnswerAfterCursor(context, cursor, markdown, blocks);
    const anchorNote = cursor && anchor ? ` · jangkar: “${anchor.slice(0, 70)}${anchor.length > 70 ? "…" : ""}”` : "";
    return `${blocks.length} bagian jawaban dimasukkan ${placement}${styleNote(outcome)}.${anchorNote} · ${TASKPANE_BUILD}`;
  });
}

// Insert the answer immediately after the paragraph the user selected (or the
// paragraph holding the cursor). WordApi 1.1 only, no anchor guessing.
export async function insertStructuredTextAfterSelection(markdown) {
  if (!globalThis.Word?.run) throw new Error("Fitur ini membutuhkan Word JavaScript API.");
  const blocks = markdownToWordBlocks(markdown);
  if (!blocks.length) throw new Error("Jawaban kosong; tidak ada yang bisa dimasukkan.");
  return Word.run(async (context) => {
    const paragraphs = context.document.getSelection().paragraphs;
    paragraphs.load("items");
    await context.sync();
    const cursor = paragraphs.items?.length
      ? paragraphs.items[paragraphs.items.length - 1]
      : null;
    if (!cursor) {
      throw new Error("Tidak ada teks atau kursor di dokumen. Klik atau blok bagian tujuan di dokumen, lalu coba lagi.");
    }
    const outcome = await writeAnswerAfterCursor(context, cursor, markdown, blocks);
    return `${blocks.length} bagian jawaban disisipkan setelah paragraf yang dipilih${styleNote(outcome)}. · ${TASKPANE_BUILD}`;
  });
}

function styleNote(outcome) {
  const styled = typeof outcome === "object" ? outcome.styled : outcome;
  if (styled) return "";
  const reason = typeof outcome === "object" && outcome.htmlError
    ? ` · HTML ditolak: ${outcome.htmlError.code || outcome.htmlError.message || "?"}${outcome.htmlError.debugInfo?.errorLocation ? ` @ ${outcome.htmlError.debugInfo.errorLocation}` : ""}`
    : "";
  return ` (tanpa gaya heading/list; versi Word ini menolak pengaturan gaya)${reason}`;
}

// HTML-first insert: insertHtml (WordApi 1.1) renders real tables, headings,
// and lists even on hosts that reject styleBuiltIn. Falls back to plain
// paragraph writing when the host rejects HTML too.
async function writeAnswerAfterCursor(context, cursor, markdown, blocks) {
  const after = Word.InsertLocation?.after || "After";
  const end = Word.InsertLocation?.end || "End";
  const target = cursor || context.document.body;
  // Some hosts reject Before/After for insertHtml on a Paragraph; inserting at
  // End (inside the end of the anchor paragraph) lands in the same place
  // visually, so try After first and End second.
  const attempts = cursor ? [after, end] : [end];
  let htmlError = null;
  if (typeof target.insertHtml === "function") {
    const html = markdownToWordHtml(markdown);
    for (const location of attempts) {
      try {
        target.insertHtml(html, location);
        await context.sync();
        return { html: true, styled: true };
      } catch (error) {
        htmlError = error;
        console.warn(`[Tantular] insertHtml(${location}) ditolak host.`, error, error?.debugInfo);
      }
    }
  }
  const styled = await writeBlocksAfterCursor(context, cursor, blocks);
  return { html: false, styled, htmlError };
}

// Shared insert core: write blocks after `cursor` (or at end of body when no
// cursor), then style in a separate batch. A host that rejects styling
// (InvalidArgument) must not lose the inserted answer.
async function writeBlocksAfterCursor(context, cursor, blocks) {
  const body = context.document.body;
  const after = Word.InsertLocation?.after || "After";
  const end = Word.InsertLocation?.end || "End";
  const useBuiltInStyles = supportsBuiltInStyles();
  const inserted = [];
  let listIndex = 0;
  let current = cursor;
  for (const block of blocks) {
    listIndex = block.type === "number" ? listIndex + 1 : 0;
    const text = useBuiltInStyles ? block.text : basicBlockText(block, listIndex);
    const paragraph = current
      ? current.insertParagraph(text, after)
      : body.insertParagraph(text, end);
    inserted.push({ paragraph, block });
    if (current) current = paragraph;
  }
  await context.sync();
  let styled = true;
  try {
    for (const item of inserted) {
      if (useBuiltInStyles) styleWordParagraph(item.paragraph, item.block);
      else formatWordParagraphBasic(item.paragraph, item.block);
    }
    await context.sync();
  } catch (styleError) {
    styled = false;
    console.warn("[Tantular] Gaya paragraf ditolak host; teks tetap masuk.", styleError, styleError?.debugInfo);
  }
  return styled;
}

// Backwards-compatible alias: append at end of document.
export async function appendStructuredTextToWord(markdown) {
  return insertStructuredTextIntoWord(markdown, {});
}

function stripInlineMarkdown(text) {
  return String(text || "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .trim();
}

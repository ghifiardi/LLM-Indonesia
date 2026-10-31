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

// Map an instruction like "buat chart/grafik garis" to an Excel chart type.
// Returns "" when no chart was asked for.
export function requestedExcelChartType(instruction) {
  const text = String(instruction || "");
  if (!/\b(chart|grafik|diagram)\b/i.test(text)) return "";
  if (/\b(line|garis|tren|trend)\b/i.test(text)) return "Line";
  if (/\b(pie|lingkaran|donat|doughnut)\b/i.test(text)) return "Pie";
  if (/\b(bar|horizontal)\b/i.test(text)) return "BarClustered";
  return "ColumnClustered";
}

export async function writeWorkbookSpecToExcel(spec, mode = "new_sheets", options = {}) {
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
    let chartCount = 0;

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

      // Chart on request ("buat chart/grafik") — ExcelApi 1.1 charts.add over
      // the freshly written header+data range, placed below the data.
      if (options.chartType && columns.length && rows.length) {
        try {
          const dataRange = sheet.getRangeByIndexes(0, 0, values.length, columns.length);
          const chart = sheet.charts.add(options.chartType, dataRange, "Auto");
          chart.setPosition(
            sheet.getRangeByIndexes(values.length + (sheetSpec.notes?.length || 0) + 2, 0, 1, 1),
            sheet.getRangeByIndexes(values.length + (sheetSpec.notes?.length || 0) + 17, Math.max(7, columns.length), 1, 1)
          );
          try { chart.title.text = sheetSpec.name || spec.title || "Chart"; } catch (_) { /* optional */ }
          chartCount += 1;
        } catch (chartError) {
          console.warn("Chart creation failed; data sheet still written.", chartError, chartError?.debugInfo);
        }
      }
      if (!firstOutput) firstOutput = sheet;
    }

    firstOutput?.activate();
    await context.sync();
    const chartNote = options.chartType
      ? (chartCount ? ` ${chartCount} chart (${options.chartType}) ditambahkan di bawah data.` : " Chart diminta tetapi gagal dibuat pada host ini.")
      : "";
    return `${spec.sheets.length} sheet dibuat di workbook aktif.${chartNote}`;
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
        for (const id of slideIds) {
          const all = allSlides.items || [];
          // Prefer the exact live PowerPoint ID. Only use the cross-API
          // component matcher when it identifies exactly one slide.
          let index = all.findIndex((slide) => String(slide.id || "") === String(id || ""));
          if (index < 0) {
            const loose = all
              .map((slide, candidateIndex) => sameSlideId(slide.id, id) ? candidateIndex : -1)
              .filter((candidateIndex) => candidateIndex >= 0);
            if (loose.length === 1) index = loose[0];
          }
          if (index >= 0) slideIndexes.push(index + 1);
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

// Pure verdict for a single-slide insert: given the deck's slide ids before and
// after the insert plus the anchor's live id, decide whether EXACTLY one slide
// was added AND whether it sits immediately after the anchor. Splitting this out
// keeps the check testable without an Office mock, and keeps the caller from
// claiming a success it never observed.
export function verifyInsertAfter(beforeIds, afterIds, anchorId) {
  const before = (Array.isArray(beforeIds) ? beforeIds : []).map((id) => String(id || ""));
  const after = (Array.isArray(afterIds) ? afterIds : []).map((id) => String(id || ""));
  const deckChanged = after.length !== before.length;
  const added = after.filter((id) => id && !before.includes(id));

  if (after.length !== before.length + 1 || added.length !== 1) {
    return {
      inserted: false,
      deckChanged,
      index: 0,
      reason: `PowerPoint menambahkan ${added.length} slide (deck ${before.length} → ${after.length}); ` +
        "penyisipan tidak bisa dipastikan. Periksa deck sebelum melanjutkan."
    };
  }

  const anchorPos = after.findIndex((id) => id === String(anchorId || ""));
  if (anchorPos < 0) {
    return {
      inserted: false,
      deckChanged,
      index: 0,
      reason: "Slide acuan tidak ditemukan lagi setelah penyisipan, jadi posisi slide baru tidak bisa dipastikan."
    };
  }
  if (after[anchorPos + 1] !== added[0]) {
    return {
      inserted: false,
      deckChanged,
      index: after.indexOf(added[0]) + 1,
      reason: `Slide baru mendarat di posisi ${after.indexOf(added[0]) + 1}, bukan tepat setelah slide acuan. ` +
        "Periksa dan geser sendiri di panel thumbnail."
    };
  }
  return { inserted: true, deckChanged, index: anchorPos + 2, reason: "" };
}

// Insert ONE generated slide immediately after an existing slide, then verify it
// really landed there before reporting success. Separate from
// insertDeckIntoActivePresentation on purpose: that one inserts a whole Deck
// Studio deck and must keep its current fire-and-forget behavior for its caller.
export async function insertSlideAfterInActivePresentation(base64, { slideId = "", slideIndex = 0, formatting = "UseDestinationTheme" } = {}) {
  if (!globalThis.PowerPoint?.run) {
    throw new Error("PowerPoint JavaScript API tidak tersedia. Buka pane ini di PowerPoint.");
  }
  return PowerPoint.run(async (context) => {
    if (typeof context.presentation.insertSlidesFromBase64 !== "function") {
      throw new Error("Host PowerPoint ini belum mendukung insertSlidesFromBase64.");
    }

    const readSlideIds = async () => {
      const collection = context.presentation.slides;
      collection.load("items");
      await context.sync();
      for (const slide of collection.items || []) slide.load("id");
      await context.sync();
      return (collection.items || []).map((slide) => String(slide.id || ""));
    };

    // Read → insert → sync → read again, all inside ONE run context, so the
    // "after" list is the real post-insert deck rather than a stale proxy.
    const before = await readSlideIds();
    const { targetLiveId } = resolveReplaceTarget(before, { slideId, slideIndex });
    if (!targetLiveId) {
      return {
        inserted: false,
        deckChanged: false,
        index: 0,
        reason: "Slide acuan tidak ditemukan lagi di deck aktif, jadi tidak ada yang disisipkan."
      };
    }

    context.presentation.insertSlidesFromBase64(base64, {
      formatting,
      targetSlideId: toInsertTargetSlideId(targetLiveId)
    });
    await context.sync();

    const after = await readSlideIds();
    return verifyInsertAfter(before, after, targetLiveId);
  });
}

// PowerPoint target IDs can appear as "257#", "#creationId", or
// "257#creationId". The Common API may return only "257". Match either
// non-empty component so IDs from different PowerPoint API surfaces resolve
// to the same slide without treating two empty components as equal.
export function sameSlideId(a, b) {
  const parts = (value) => {
    const raw = String(value || "").trim();
    const hash = raw.indexOf("#");
    return hash < 0
      ? { raw, slide: raw, creation: "" }
      : { raw, slide: raw.slice(0, hash).trim(), creation: raw.slice(hash + 1).trim() };
  };
  const left = parts(a);
  const right = parts(b);
  if (!left.raw || !right.raw) return false;
  if (left.raw === right.raw) return true;
  if (left.slide && right.slide && left.slide === right.slide) return true;
  return Boolean(left.creation && right.creation && left.creation === right.creation);
}

// Pure resolver: given the deck's live slide id list (in visual order) and the
// caller's requested {slideId, slideIndex}, return the deck's OWN id for the
// target plus its 1-based index. Grounding on the live collection's id — not
// the raw selected id, which a different API surface may format differently —
// keeps the insert anchor and the later delete pointed at the same slide.
// --- In-place slide text edit ------------------------------------------------
// "Perbaiki slide ini" used to build a NEW slide in the Deck Studio style and
// replace the original, so the deck's master, colours and footer were lost.
// Now the improved text is written into the slide's EXISTING shapes, mapped
// onto the slide's real structure: title + one body, or title + N column
// bodies with optional heading boxes above them. Identification is
// conservative: a wrong shape rewritten is damage with no undo, and a stale
// heading left beside new text is a wrong slide — so anything that does not
// map cleanly is a refusal and the caller reports "tidak diubah".
const TITLE_SHAPE_RE = /\b(title|judul)\b/i;
const CHROME_SHAPE_RE = /\b(footer|slide number|date|header)\b/i;
const FOOTER_TEXT_RE = /·\s*\d+\s*\/\s*\d+\s*$/;

// A column is often ONE shape whose first paragraph is the heading and the
// rest are bullets (live slide, 2026-09-03). Such an inline heading must be
// kept — writing the whole shape erased it and gave every line its style.
function inlineHeadingOf(lines) {
  if (lines.length < 2) return "";
  const first = lines[0];
  const rest = lines.slice(1);
  const mean = rest.reduce((sum, line) => sum + line.length, 0) / rest.length;
  // Short, no sentence punctuation, and clearly shorter than the bullets
  // under it — a short first BULLET ("Read it twice" over "Cite the exhibit")
  // is not a heading.
  return first.length <= 60 && !/[.!?:;]$/.test(first) && first.length <= 0.6 * mean ? first : "";
}

function classifyShapes(shapes) {
  const list = (Array.isArray(shapes) ? shapes : []).map((shape, index) => ({
    index,
    name: String(shape?.name || ""),
    text: String(shape?.text || "").replace(/\r\n?/g, "\n").trim()
  }));
  const textual = list.filter((shape) => shape.text && !CHROME_SHAPE_RE.test(shape.name) && !FOOTER_TEXT_RE.test(shape.text));
  if (!textual.length) return null;
  const title = textual.find((shape) => TITLE_SHAPE_RE.test(shape.name)) || textual[0];
  const rest = textual.filter((shape) => shape !== title);
  // A body is a multi-paragraph shape. Every single-line shape (column
  // heading, caption, a footer text box) is a heading candidate; only the
  // first N of them, in slide order, pair with the N bodies.
  const isHeading = (shape) => !shape.text.includes("\n");
  // Builder layout (Deck Studio, live 2026-09-05): every bullet is its own
  // text box, stacked in one column under the title. Three or more such boxes
  // sharing a left edge are ONE bullets body split across slots — not N
  // columns, which is what the model was steered to and what the writer then
  // refused. Read as one body; write one bullet per slot.
  const candidates = rest.filter((shape) => !FOOTER_TEXT_RE.test(shape.text) && !/·/.test(shape.text));
  if (candidates.length >= 3) {
    const lefts = candidates.map((shape) => Number(shapes[shape.index]?.left));
    const aligned = lefts.every((l) => Number.isFinite(l)) && Math.max(...lefts) - Math.min(...lefts) <= 24;
    if (aligned) {
      const lines = candidates.flatMap((shape) => shape.text.split("\n").map((line) => line.trim()).filter(Boolean));
      return {
        title, layout: "split_bullets", slots: candidates.map((shape) => shape.index),
        bodies: [{ index: candidates[0].index, inlineHeading: "", lines }], headings: []
      };
    }
  }
  const bodies = rest.filter((shape) => !isHeading(shape)).map((shape) => {
    const lines = shape.text.split("\n").map((line) => line.trim()).filter(Boolean);
    const inlineHeading = inlineHeadingOf(lines);
    return { ...shape, inlineHeading, lines: inlineHeading ? lines.slice(1) : lines };
  });
  return { title, bodies, headings: rest.filter(isHeading) };
}

// A slide the Deck Studio builder produced carries its footer.
export function isDeckStudioSlide(shapes) {
  return (Array.isArray(shapes) ? shapes : []).some((shape) => /tantular deck studio/i.test(String(shape?.text || "")));
}

export function describeSlideStructure(shapes) {
  const parts = classifyShapes(shapes);
  if (!parts) return { title: "", bodies: 0, headings: [], blocks: [] };
  const title = parts.title.text;
  if (parts.layout === "split_bullets") {
    return { title, bodies: 1, headings: [], blocks: [parts.bodies[0].lines],
             slots: parts.slots.length, layout: "split_bullets", deckStudio: isDeckStudioSlide(shapes) };
  }
  // A single-shape slide (title + one short line) still has one body: the line.
  if (!parts.bodies.length && parts.headings.length === 1) {
    return { title, bodies: 1, headings: [], blocks: [[parts.headings[0].text]] };
  }
  const paired = parts.headings.slice(0, parts.bodies.length);
  const headings = parts.bodies.map((body, i) => body.inlineHeading || paired[i]?.text || "").filter(Boolean);
  return { title, bodies: parts.bodies.length, headings, blocks: parts.bodies.map((body) => body.lines) };
}

function flattenToLines(slide) {
  const type = String(slide?.type || "");
  if (type === "bullets" || type === "agenda") {
    return (Array.isArray(slide.bullets) ? slide.bullets : []).map((b) => String(b || "").trim()).filter(Boolean);
  }
  if (type === "columns") {
    return (Array.isArray(slide.columns) ? slide.columns : []).flatMap((col) => [
      String(col?.title || "").trim(),
      ...(Array.isArray(col?.points) ? col.points : []).map((pt) => String(pt || "").trim())
    ]).filter(Boolean);
  }
  if (type === "cards") {
    return (Array.isArray(slide.cards) ? slide.cards : []).map((card) => {
      const title = String(card?.title || "").trim();
      const desc = String(card?.desc || "").trim();
      return title && desc ? `${title}: ${desc}` : title || desc;
    }).filter(Boolean);
  }
  return null;
}

// Pure: which shapes get which text, or null when the result does not fit.
// A write with `afterFirstParagraph` replaces only the paragraphs after the
// shape's inline heading, so the heading and the bullets' formatting survive.
export function planInPlaceWrites(shapes, slide) {
  const parts = classifyShapes(shapes);
  if (!parts || !slide) return null;
  const type = String(slide.type || "");
  if (!["bullets", "agenda", "columns", "cards"].includes(type)) return null;
  const writes = [];
  const headline = String(slide.headline || "").trim();
  if (headline) writes.push({ index: parts.title.index, text: headline });
  const bodyWrite = (body, lines) => (body.inlineHeading
    ? { index: body.index, text: lines.join("\n"), afterFirstParagraph: true }
    : { index: body.index, text: lines.join("\n") });

  if (parts.layout === "split_bullets") {
    // One bullet per box, in slide order; overflow joins into the last box;
    // boxes beyond the bullets are cleared so no stale text survives.
    const lines = flattenToLines(slide);
    if (!lines || !lines.length) return null;
    const slots = parts.slots;
    slots.forEach((index, i) => {
      if (i < lines.length) {
        writes.push({ index, text: i === slots.length - 1 ? lines.slice(i).join("\n") : lines[i] });
      } else {
        writes.push({ index, text: "", clear: true });
      }
    });
    return writes;
  }

  let bodies = parts.bodies;
  let headings = parts.headings;
  if (!bodies.length && headings.length === 1) { bodies = [{ ...headings[0], inlineHeading: "" }]; headings = []; }
  if (!bodies.length) return null;

  if (bodies.length === 1) {
    const lines = flattenToLines(slide);
    if (!lines || !lines.length) return null;
    writes.push(bodyWrite(bodies[0], lines));
    return writes;
  }

  // Several bodies: only a columns result with exactly that many columns fits.
  if (type !== "columns") return null;
  const columns = Array.isArray(slide.columns) ? slide.columns : [];
  if (columns.length !== bodies.length) return null;
  const pairedHeadings = headings.slice(0, bodies.length);
  columns.forEach((col, i) => {
    const title = String(col?.title || "").trim();
    const points = (Array.isArray(col?.points) ? col.points : []).map((pt) => String(pt || "").trim()).filter(Boolean);
    // An inline heading is kept as it is; only a separate heading shape is rewritten.
    if (title && !bodies[i].inlineHeading && pairedHeadings[i]) writes.push({ index: pairedHeadings[i].index, text: title });
    if (points.length) writes.push(bodyWrite(bodies[i], points));
  });
  return writes.sort((x, y) => x.index - y.index);
}

// Pure: true when applying `writes` would leave every touched shape with the
// text it already has (grounding put every rewording back). The caller then
// reports "tidak diubah" instead of a false ✅ and skips the write.
export function writesChangeNothing(shapes, writes) {
  const norm = (text) => String(text || "").replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
  return (Array.isArray(writes) ? writes : []).every((write) => {
    const current = norm(shapes?.[write.index]?.text);
    const target = norm(write.text);
    if (!write.afterFirstParagraph) return current === target;
    const rest = current.split("\n").slice(1).join("\n");
    return rest === target;
  });
}

// --- Layout repair -------------------------------------------------------------
// Applies a deck/slideLayout reflow: top, height, font size, and merged text
// only. Left, width, colours and every other shape are untouched.
export async function applySlideLayout(target = {}, writes = []) {
  if (!globalThis.PowerPoint?.run) {
    throw new Error("PowerPoint JavaScript API tidak tersedia. Buka pane ini di PowerPoint.");
  }
  const list = (Array.isArray(writes) ? writes : []).filter((w) => Number.isInteger(w?.index));
  if (!list.length) return { updated: false, reason: "tidak ada perubahan tata letak" };
  return PowerPoint.run(async (context) => {
    const loaded = await loadSlideShapes(context, target);
    if (!loaded) return { updated: false, reason: "slide target tidak ditemukan di deck aktif" };
    for (const write of list) {
      const shape = loaded.shapes[write.index];
      if (!shape) return { updated: false, reason: `shape #${write.index + 1} tidak ditemukan` };
      if (write.top !== undefined) shape.top = write.top;
      if (write.height !== undefined) shape.height = write.height;
      const range = loaded.ranges[write.index];
      if (range && write.fontSize !== undefined) { try { range.font.size = write.fontSize; } catch (_) { /* best effort */ } }
      if (range && write.text !== undefined) range.text = write.clear ? "" : String(write.text);
    }
    await context.sync();
    return { updated: true, changed: list.length };
  });
}

// --- Native visual cards --------------------------------------------------------
// Card panels drawn ON the user's slide (design review 2026-09-03). Rules:
// identify what to replace conservatively and refuse when unsure (no undo);
// feature-detect every method used; create → sync → verify → delete LAST; a
// failed create removes what it made. Style reads that come back empty are
// resolved by deck/nativeCards.resolveCardStyle with explicit fallbacks.
const NATIVE_METHODS = ["addGeometricShape", "addTextBox"];

export function planNativeCardTargets(shapes) {
  const parts = classifyShapes(shapes);
  if (!parts || !parts.bodies.length) return { ok: false, reason: "tidak ada shape isi yang bisa diganti menjadi kartu" };
  const geometry = (index) => {
    const sh = shapes[index] || {};
    return { left: Number(sh.left) || 0, top: Number(sh.top) || 0, width: Number(sh.width) || 0, height: Number(sh.height) || 0 };
  };
  const bodies = parts.bodies;
  if (bodies.some((b) => { const g = geometry(b.index); return g.width <= 0 || g.height <= 0; })) {
    return { ok: false, reason: "geometri shape isi tidak terbaca, jadi kartu tidak bisa ditempatkan dengan aman" };
  }
  // Single-line text shapes: either exactly one heading per body (they go
  // with the bodies) or none. Any other count is ambiguous — a caption could
  // be mistaken for a heading and deleted — so refuse.
  const stray = parts.headings.filter((h) => !FOOTER_TEXT_RE.test(h.text) && !/·/.test(h.text));
  if (stray.length !== 0 && stray.length !== bodies.length) {
    return { ok: false, reason: `tidak yakin shape mana yang isi dan mana yang keterangan (${stray.length} baris tunggal, ${bodies.length} isi); tidak ada yang dihapus` };
  }
  const targets = [...bodies, ...stray].map((s) => s.index).sort((a, b) => a - b);
  const boxes = targets.map(geometry);
  const left = Math.min(...boxes.map((g) => g.left));
  const top = Math.min(...boxes.map((g) => g.top));
  const right = Math.max(...boxes.map((g) => g.left + g.width));
  const bottom = Math.max(...boxes.map((g) => g.top + g.height));
  return { ok: true, box: { left, top, width: right - left, height: bottom - top }, deleteIndexes: targets };
}

function readFont(range) {
  const font = range?.font || {};
  const value = (v) => (typeof v === "string" ? v : "");
  return { name: value(font.name), color: value(font.color), size: Number(font.size) || 0 };
}

export async function readSlideDesign(target = {}) {
  if (!globalThis.PowerPoint?.run) {
    throw new Error("PowerPoint JavaScript API tidak tersedia. Buka pane ini di PowerPoint.");
  }
  return PowerPoint.run(async (context) => {
    const loaded = await loadSlideShapes(context, target);
    if (!loaded) return { found: false, shapes: [] };
    for (const [i, shape] of loaded.shapes.entries()) {
      try { shape.load("left,top,width,height"); } catch (_) { /* ignore */ }
      try { shape.fill?.load?.("foregroundColor"); } catch (_) { /* ignore */ }
      try { loaded.ranges[i]?.font?.load?.("name,color,size"); } catch (_) { /* ignore */ }
    }
    await context.sync();
    const shapes = loaded.shapes.map((shape, i) => ({
      name: String(shape.name || ""), text: String(loaded.ranges[i]?.text || ""),
      left: Number(shape.left) || 0, top: Number(shape.top) || 0, width: Number(shape.width) || 0, height: Number(shape.height) || 0
    }));
    const parts = classifyShapes(shapes);
    const title = parts ? readFont(loaded.ranges[parts.title.index]) : readFont(null);
    const body = parts?.bodies?.[0] ? readFont(loaded.ranges[parts.bodies[0].index]) : readFont(null);
    const heading = parts?.headings?.[0] ? readFont(loaded.ranges[parts.headings[0].index]) : readFont(null);
    const collection = loaded.slide.shapes;
    const api = Object.fromEntries(NATIVE_METHODS.map((m) => [m, typeof collection[m] === "function"]));
    // Accent colours from the slide's own small marker shapes, in slide order
    // and de-duplicated: the composer alternates them for panel bars.
    const accents = [];
    const bars = [];
    for (const [i, shape] of loaded.shapes.entries()) {
      const meta = shapes[i];
      if (meta.text) continue;
      const isMarker = meta.width <= 24 && meta.height <= 24;
      const isBar = meta.width <= 14 && meta.height >= 200;
      if (!isMarker && !isBar) continue;
      let color = "";
      try { color = String(shape.fill?.foregroundColor || shape.fillColor || ""); } catch (_) { /* ignore */ }
      if (!/^#?[0-9a-f]{6}$/i.test(color)) continue;
      const hex = (color.startsWith("#") ? color : `#${color}`).toUpperCase();
      const target = isMarker ? accents : bars;
      if (!target.includes(hex)) target.push(hex);
    }
    return { found: true, shapes, title, body, headingColor: heading.color, accents, bars, api };
  });
}

export async function buildNativeCardsOnSlide(target = {}, plan = [], deleteIndexes = []) {
  if (!globalThis.PowerPoint?.run) {
    throw new Error("PowerPoint JavaScript API tidak tersedia. Buka pane ini di PowerPoint.");
  }
  const list = Array.isArray(plan) ? plan : [];
  if (!list.length) return { updated: false, reason: "tidak ada kartu yang bisa digambar" };
  return PowerPoint.run(async (context) => {
    const loaded = await loadSlideShapes(context, target);
    if (!loaded) return { updated: false, reason: "slide target tidak ditemukan di deck aktif" };
    const collection = loaded.slide.shapes;
    const missing = NATIVE_METHODS.filter((m) => typeof collection[m] !== "function");
    if (missing.length) {
      return { updated: false, reason: `host PowerPoint ini tidak menyediakan ${missing.join(", ")} (butuh PowerPointApi 1.4); kartu tidak dibuat` };
    }
    const before = loaded.shapes.length;
    const oldShapes = deleteIndexes.map((i) => loaded.shapes[i]).filter(Boolean);
    const created = [];

    // Remove everything this call created. Deletes are queued and applied at
    // a sync; if that sync throws (it did, live 2026-09-05), re-read the
    // collection and delete by id, up to three passes, and report honestly.
    const cleanup = async () => {
      let remaining = created.slice();
      for (let pass = 0; pass < 3 && remaining.length; pass += 1) {
        try {
          for (const shape of remaining) shape.delete();
          await context.sync();
          remaining = [];
        } catch (_) {
          try {
            collection.load("items");
            await context.sync();
            const ids = new Set(created.map((c) => c.__id).filter(Boolean));
            const live = (collection.items || []).filter((shape) => ids.has(String(shape.id)));
            remaining = live;
          } catch (_2) { /* next pass retries the same list */ }
        }
      }
      return remaining.length === 0;
    };

    // Phase 1: create + geometry only. On this host a just-added shape's text
    // frame is not addressable until after a sync, so styling waits.
    try {
      for (const item of list) {
        if (item.text === undefined && item.fill !== undefined) {
          created.push(collection.addGeometricShape("Rectangle", { left: item.left, top: item.top, width: item.width, height: item.height }));
        } else {
          created.push(collection.addTextBox(String(item.text ?? ""), { left: item.left, top: item.top, width: item.width, height: item.height }));
        }
      }
      // Creation must be synced on its own first: on this host (live, host42)
      // even a load() on a not-yet-synced new shape is InvalidArgument.
      await context.sync();
      for (const shape of created) { try { shape.load("id"); } catch (_) { /* ignore */ } }
      collection.load("items");
      await context.sync();
      for (const shape of created) { try { shape.__id = String(shape.id || ""); } catch (_) { /* ignore */ } }
      const now = (collection.items || []).length;
      if (now < before + list.length) throw new Error(`hanya ${now - before} dari ${list.length} shape yang terbentuk`);
    } catch (error) {
      const clean = await cleanup();
      return { updated: false, reason: `pembuatan kartu gagal (${error?.message || error}); `
        + (clean ? "slide tidak diubah" : "PERHATIAN: sebagian shape baru tidak bisa dihapus otomatis, hapus manual") };
    }

    // Phase 2: styling, in the smallest batches that still fail safe. Fills
    // first, then fonts. A batch that throws is retried per shape; a shape
    // whose styling still fails aborts the whole build and removes everything.
    const styleFill = (shape, item) => {
      try { shape.fill.setSolidColor(item.fill); } catch (_) { /* best effort */ }
      try { if (item.alpha !== undefined) shape.fill.transparency = 1 - item.alpha; } catch (_) { /* ignore */ }
      try { shape.lineFormat.visible = false; } catch (_) { /* ignore */ }
    };
    const styleText = (shape, item) => {
      const font = shape.textFrame.textRange.font;
      if (item.font?.name) font.name = item.font.name;
      if (item.font?.color) font.color = item.font.color;
      if (item.font?.size) font.size = item.font.size;
      font.bold = Boolean(item.font?.bold);
      try { shape.textFrame.wordWrap = true; } catch (_) { /* ignore */ }
    };
    const batches = [
      ["fill", list.map((item, i) => [created[i], item]).filter(([, item]) => item.text === undefined && item.fill !== undefined)],
      ["text", list.map((item, i) => [created[i], item]).filter(([, item]) => item.text !== undefined)]
    ];
    for (const [kind, pairs] of batches) {
      const apply = (shape, item) => (kind === "fill" ? styleFill(shape, item) : styleText(shape, item));
      try {
        for (const [shape, item] of pairs) apply(shape, item);
        await context.sync();
      } catch (batchError) {
        // Retry one shape at a time so a single bad property does not take
        // the rest down; any shape that still fails aborts.
        for (const [shape, item] of pairs) {
          try { apply(shape, item); await context.sync(); }
          catch (error) {
            const clean = await cleanup();
            return { updated: false, reason: `penataan ${kind === "fill" ? "warna" : "huruf"} gagal (${error?.message || batchError?.message || error}); `
              + (clean ? "slide tidak diubah" : "PERHATIAN: sebagian shape baru tidak bisa dihapus otomatis, hapus manual") };
          }
        }
      }
    }

    // Phase 3: delete the old shapes LAST, in one batch.
    for (const shape of oldShapes) shape.delete();
    await context.sync();
    return { updated: true, created: list.length };
  });
}

async function loadSlideShapes(context, { slideId = "", slideIndex = 0 } = {}) {
  const collection = context.presentation.slides;
  collection.load("items");
  await context.sync();
  const items = collection.items || [];
  for (const slide of items) slide.load("id");
  await context.sync();
  const liveIds = items.map((slide) => String(slide.id || ""));
  const { targetLiveId, targetIndex } = resolveReplaceTarget(liveIds, { slideId, slideIndex });
  const slide = targetLiveId ? items[targetIndex - 1] : null;
  if (!slide) return null;
  slide.shapes.load("items");
  await context.sync();
  const shapes = slide.shapes.items || [];
  const ranges = shapes.map((shape) => {
    try { shape.load("name"); } catch (_) { /* ignore */ }
    try {
      const range = shape.textFrame.textRange;
      range.load("text");
      return range;
    } catch (_) { return null; }
  });
  await context.sync();
  return { slide, shapes, ranges };
}

export async function readSlideShapeTexts(target = {}) {
  if (!globalThis.PowerPoint?.run) {
    throw new Error("PowerPoint JavaScript API tidak tersedia. Buka pane ini di PowerPoint.");
  }
  return PowerPoint.run(async (context) => {
    const loaded = await loadSlideShapes(context, target);
    if (!loaded) return { found: false, shapes: [] };
    // Geometry too (2026-09-05): the builder-layout rule needs left edges.
    for (const [i, shape] of loaded.shapes.entries()) {
      try { shape.load("left,top,width,height"); } catch (_) { /* ignore */ }
      try { loaded.ranges[i]?.font?.load?.("size"); } catch (_) { /* ignore */ }
    }
    await context.sync();
    return {
      found: true,
      shapes: loaded.shapes.map((shape, index) => ({
        name: String(shape.name || ""), text: String(loaded.ranges[index]?.text || ""),
        left: Number(shape.left) || 0, top: Number(shape.top) || 0,
        width: Number(shape.width) || 0, height: Number(shape.height) || 0,
        fontSize: Number(loaded.ranges[index]?.font?.size) || 0
      }))
    };
  });
}

export async function writeSlideShapeTexts(target = {}, writes = []) {
  if (!globalThis.PowerPoint?.run) {
    throw new Error("PowerPoint JavaScript API tidak tersedia. Buka pane ini di PowerPoint.");
  }
  const list = (Array.isArray(writes) ? writes : []).filter((w) => Number.isInteger(w?.index) && (w?.clear || String(w?.text || "").trim()));
  if (!list.length) return { updated: false, reason: "tidak ada teks yang bisa ditulis" };
  return PowerPoint.run(async (context) => {
    const loaded = await loadSlideShapes(context, target);
    if (!loaded) return { updated: false, reason: "slide target tidak ditemukan di deck aktif" };
    for (const write of list) {
      const range = loaded.ranges[write.index];
      if (!range) return { updated: false, reason: `shape #${write.index + 1} tidak punya teks yang bisa ditulis` };
    }
    for (const write of list) {
      const range = loaded.ranges[write.index];
      const text = write.clear ? "" : String(write.text).trim();
      if (!write.afterFirstParagraph) { range.text = text; continue; }
      // Keep paragraph 1 (the inline heading). Replace the rest through a
      // substring range so the new paragraphs inherit the bullets' formatting,
      // not the heading's. Hosts without getSubstring fall back to rewriting
      // the shape with the heading put back in front.
      const raw = String(range.text || "");
      const cut = raw.search(/\r|\n/);
      if (cut < 0) { range.text = text; continue; }
      const start = cut + 1;
      if (typeof range.getSubstring === "function" && raw.length > start) {
        range.getSubstring(start, raw.length - start).text = text;
      } else {
        range.text = `${raw.slice(0, cut)}\n${text}`;
      }
    }
    await context.sync();
    return { updated: true };
  });
}

export function resolveReplaceTarget(liveIds, { slideId = "", slideIndex = 0 } = {}) {
  const ids = (Array.isArray(liveIds) ? liveIds : []).map((id) => String(id || ""));
  if (slideId) {
    const exact = ids.findIndex((id) => id === String(slideId));
    if (exact >= 0) return { targetLiveId: ids[exact], targetIndex: exact + 1 };
    const matches = ids
      .map((id, index) => sameSlideId(id, slideId) ? index : -1)
      .filter((index) => index >= 0);
    if (matches.length === 1) {
      const byId = matches[0];
      return { targetLiveId: ids[byId], targetIndex: byId + 1 };
    }
    // An explicit ID is stronger evidence than a positional fallback. If it
    // disappeared while the model was generating, refuse instead of replacing
    // whichever slide happens to occupy the old index now.
    return { targetLiveId: "", targetIndex: 0 };
  }
  const index = Number(slideIndex) || 0;
  if (index > 0 && ids[index - 1]) {
    return { targetLiveId: ids[index - 1], targetIndex: index };
  }
  return { targetLiveId: "", targetIndex: 0 };
}

// Pure chooser: after inserting the improved slide AFTER the original, decide
// WHICH slide in the post-insert collection is the original to delete. The
// original keeps its stable ID. Position is used only to prefer among matching
// candidates, never as an unverified fallback that could delete another slide.
// Returns the 0-based index into afterIds, or -1 when nothing matches.
export function pickOriginalIndex(afterIds, { targetLiveId = "", targetIndex = 0 } = {}) {
  const ids = (Array.isArray(afterIds) ? afterIds : []).map((id) => String(id || ""));
  if (!ids.length) return -1;
  // A Slide.id obtained from presentation.slides is unique and stable for that
  // presentation. Always prefer its exact value. An imported slide can reuse a
  // numeric or creation-id component from its source presentation; treating a
  // component match as identity can therefore delete the newly imported slide
  // instead of the original (the real Mac PowerPoint regression).
  const exact = ids.findIndex((id) => id === targetLiveId && targetLiveId);
  if (exact >= 0) return exact;
  // Cross-format fallback is safe only when exactly one live slide matches.
  const loose = ids
    .map((id, index) => sameSlideId(id, targetLiveId) ? index : -1)
    .filter((index) => index >= 0);
  if (loose.length === 1) return loose[0];
  return -1;
}

// insertSlidesFromBase64 does not accept a bare numeric Slide.id. Microsoft
// documents targetSlideId as nnn#, #creationId, or nnn#creationId. The live
// Slide.id is commonly just "257", so add the delimiter in that case.
export function toInsertTargetSlideId(liveId) {
  const id = String(liveId || "").trim();
  if (!id) return "";
  return id.includes("#") ? id : `${id}#`;
}

// Replace one slide in the active presentation with the slide(s) from a
// generated .pptx: insert after the target, then delete the original so the
// improved version takes the SAME position instead of piling up as extra
// pages. It preflights deletion before insertion and attempts rollback if a
// post-insert operation fails, so an unsupported host doesn't create a
// duplicate slide. Insert and delete are both in PowerPointApi 1.2.
export async function replaceSlideInActivePresentation(base64, { slideId = "", slideIndex = 0, formatting = "UseDestinationTheme" } = {}) {
  if (!globalThis.PowerPoint?.run) {
    throw new Error("PowerPoint JavaScript API tidak tersedia. Buka pane ini di PowerPoint.");
  }
  return PowerPoint.run(async (context) => {
    if (typeof context.presentation.insertSlidesFromBase64 !== "function") {
      throw new Error("Host PowerPoint ini belum mendukung insertSlidesFromBase64.");
    }

    const readSlideIds = async () => {
      const collection = context.presentation.slides;
      collection.load("items");
      await context.sync();
      for (const slide of collection.items || []) {
        slide.load("id");
      }
      await context.sync();
      const items = collection.items || [];
      return { items, ids: items.map((slide) => String(slide.id || "")) };
    };

    // Within one live presentation Slide.id is unique. Use exact identity
    // after insertion; component matching is only for crossing API surfaces.
    const idsAddedSince = (baseline, current) => current.filter(
      (id) => id && !baseline.includes(id)
    );

    // Same delete-and-verify contract as deleteSlidesInActivePresentation():
    // delete, re-read, and only report success when the ids are actually gone.
    // Kept inline because it must share this PowerPoint.run context with the
    // insert above.
    const deleteSlidesByIds = async (ids) => {
      if (!ids.length) return true;
      const snapshot = await readSlideIds();
      const targets = snapshot.items.filter((_, index) =>
        ids.includes(snapshot.ids[index])
      );
      if (targets.length !== ids.length || targets.some((slide) => typeof slide.delete !== "function")) {
        return false;
      }
      targets.forEach((slide) => slide.delete());
      await context.sync();
      const verify = await readSlideIds();
      return !verify.ids.some((currentId) => ids.includes(currentId));
    };

    // Mac PowerPoint silently ignores Slide.delete() when the slide being
    // deleted is the ACTIVE selection — and the user selected exactly the
    // slide they want improved, so the original is always selected at delete
    // time. Moving the selection onto another slide (the freshly inserted one)
    // first lets the delete actually take effect. Best-effort: needs
    // PowerPointApi 1.5 (setSelectedSlides); if absent we still try the delete.
    const trySelectSlideIds = async (ids) => {
      const wanted = (Array.isArray(ids) ? ids : []).filter(Boolean);
      if (!wanted.length) return false;
      try {
        if (typeof context.presentation.setSelectedSlides !== "function") return false;
        context.presentation.setSelectedSlides(wanted);
        await context.sync();
        return true;
      } catch (_) {
        // Selection move is best-effort; deletion may still succeed without it.
        return false;
      }
    };

    // 1. Snapshot the deck BEFORE inserting so we know the target's OWN id and
    // position, and can later tell new slides apart from existing ones.
    const before = await readSlideIds();
    const { targetLiveId, targetIndex } = resolveReplaceTarget(before.ids, { slideId, slideIndex });

    if (!targetLiveId) {
      // No safe anchor: refuse rather than dropping the slide at the top of
      // the deck, which reads as corruption to the user.
      throw new Error(
        "PowerPoint tidak mengekspos ID slide terpilih, jadi Tantular tidak bisa menentukan posisi yang benar. " +
        "Klik langsung slide-nya di panel thumbnail lalu coba lagi, atau tulis \"slide #N\" di kotak instruksi."
      );
    }

    const originalBefore = before.items[targetIndex - 1];
    if (!originalBefore || typeof originalBefore.delete !== "function") {
      return {
        replaced: false,
        inserted: false,
        reason: "Host PowerPoint ini belum mendukung penghapusan slide via API (butuh PowerPointApi 1.2)."
      };
    }

    // 2. Insert the improved slide AFTER the target, using the deck's own id so
    // the anchor format always matches what this host expects.
    context.presentation.insertSlidesFromBase64(base64, {
      formatting,
      targetSlideId: toInsertTargetSlideId(targetLiveId)
    });
    await context.sync();

    // 3. Re-read AFTER the insert (pre-insert proxies go stale) and delete the
    // original so the improved slide takes its place.
    try {
      const after = await readSlideIds();
      const insertedIds = idsAddedSince(before.ids, after.ids);
      if (insertedIds.length !== 1 || after.ids.length !== before.ids.length + 1) {
        const rolledBack = await deleteSlidesByIds(insertedIds);
        return {
          replaced: false,
          inserted: !rolledBack,
          rolledBack,
          reason: `PowerPoint menyisipkan jumlah slide yang tidak terduga (${insertedIds.length}); penggantian dibatalkan.`
        };
      }
      const originalPos = pickOriginalIndex(after.ids, { targetLiveId, targetIndex });
      const original = originalPos >= 0 ? after.items[originalPos] : null;
      if (!original) {
        const rolledBack = await deleteSlidesByIds(insertedIds);
        return {
          replaced: false,
          inserted: !rolledBack,
          rolledBack,
          reason: "Slide asli tidak ditemukan lagi setelah insert."
        };
      }
      if (typeof original.delete !== "function") {
        const rolledBack = await deleteSlidesByIds(insertedIds);
        return {
          replaced: false,
          inserted: !rolledBack,
          rolledBack,
          reason: "Host PowerPoint ini belum mendukung penghapusan slide via API (butuh PowerPointApi 1.2)."
        };
      }
      const originalId = String(after.ids[originalPos] || targetLiveId);
      // Deselect the original before deleting it: on Mac PowerPoint a delete of
      // the currently-selected slide is silently dropped. Select the inserted
      // improved slide instead (which is also the nicer post-replace state).
      await trySelectSlideIds(insertedIds);
      try {
        original.delete();
        await context.sync();
      } catch (deleteError) {
        const current = await readSlideIds();
        const originalStillExists = current.ids.includes(originalId);
        if (!originalStillExists && current.ids.length === before.ids.length) {
          return { replaced: true, inserted: true };
        }
        const rolledBack = originalStillExists
          ? await deleteSlidesByIds(insertedIds)
          : false;
        return {
          replaced: false,
          inserted: !rolledBack,
          rolledBack,
          reason: deleteError?.message || String(deleteError)
        };
      }

      // 4. Verify the original is actually gone. Some hosts silently ignore a
      // delete; without this check we would wrongly report an in-place replace
      // while the deck still shows the old slide plus a new one.
      const verify = await readSlideIds();
      const stillPresent = verify.ids.includes(originalId);
      const expectedCount = verify.ids.length === before.ids.length;
      if (stillPresent || !expectedCount) {
        // One more attempt: if the original still exists, it may still have been
        // the selection on a host that ignored setSelectedSlides. Re-select the
        // inserted slide and retry the delete once before giving up.
        if (stillPresent) {
          const retrySelected = await trySelectSlideIds(insertedIds);
          if (retrySelected) {
            const retryOk = await deleteSlidesByIds([originalId]);
            if (retryOk) {
              const recheck = await readSlideIds();
              if (recheck.ids.length === before.ids.length) {
                return { replaced: true, inserted: true };
              }
            }
          }
        }
        const rolledBack = stillPresent
          ? await deleteSlidesByIds(insertedIds)
          : false;
        return {
          replaced: false,
          inserted: !rolledBack,
          rolledBack,
          reason: "Slide asli masih ada setelah percobaan hapus (host mengabaikan delete via API)."
        };
      }
      return { replaced: true, inserted: true };
    } catch (deleteError) {
      // If we can still identify the newly inserted slide, remove it so a
      // failed replacement leaves the user's original deck unchanged.
      try {
        const current = await readSlideIds();
        const insertedIds = idsAddedSince(before.ids, current.ids);
        const rolledBack = await deleteSlidesByIds(insertedIds);
        return {
          replaced: false,
          inserted: !rolledBack,
          rolledBack,
          reason: deleteError?.message || String(deleteError)
        };
      } catch (_) {
        return { replaced: false, inserted: true, rolledBack: false, reason: deleteError?.message || String(deleteError) };
      }
    }
  });
}

// Standalone slide delete, verified. Mac PowerPoint silently ignores
// Slide.delete() when the target is the active selection, and the usual
// workaround (setSelectedSlides) needs PowerPointApi 1.5 which this host
// lacks — so we re-read afterwards and never report an unverified success.
export async function deleteSlidesInActivePresentation(ids) {
  const wanted = (Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean);
  if (!wanted.length) return { deleted: false, reason: "Tidak ada slide yang ditentukan." };
  if (!globalThis.PowerPoint?.run) {
    throw new Error("PowerPoint JavaScript API tidak tersedia. Buka pane ini di PowerPoint.");
  }
  return PowerPoint.run(async (context) => {
    const readSlideIds = async () => {
      const collection = context.presentation.slides;
      collection.load("items");
      await context.sync();
      for (const slide of collection.items || []) slide.load("id");
      await context.sync();
      const items = collection.items || [];
      return { items, ids: items.map((slide) => String(slide.id || "")) };
    };

    const snapshot = await readSlideIds();
    const targets = snapshot.items.filter((_, index) => wanted.includes(snapshot.ids[index]));
    if (targets.length !== wanted.length) {
      return { deleted: false, reason: "Slide target tidak ditemukan lagi di deck aktif." };
    }
    if (targets.some((slide) => typeof slide.delete !== "function")) {
      return { deleted: false, reason: "Host PowerPoint ini belum mendukung penghapusan slide via API." };
    }
    targets.forEach((slide) => slide.delete());
    await context.sync();
    const verify = await readSlideIds();
    const survived = verify.ids.some((id) => wanted.includes(id));
    if (survived) {
      return {
        deleted: false,
        reason: "Slide tidak terhapus — kemungkinan sedang terpilih di panel thumbnail. " +
          "Pilih slide lain lalu coba lagi."
      };
    }
    return { deleted: true };
  });
}

// Live slide ids in visual order. Used to detect a deck that moved between a
// delete proposal and its confirmation.
export async function readLiveSlideIds() {
  if (!globalThis.PowerPoint?.run) {
    throw new Error("PowerPoint JavaScript API tidak tersedia. Buka pane ini di PowerPoint.");
  }
  return PowerPoint.run(async (context) => {
    const collection = context.presentation.slides;
    collection.load("items");
    await context.sync();
    for (const slide of collection.items || []) slide.load("id");
    await context.sync();
    return (collection.items || []).map((slide) => String(slide.id || ""));
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
// Bump this whenever the task pane changes. It is the only way to tell,
// from inside Office, whether the pane you are looking at is the code you
// just edited — Word caches the bundle from when the pane was opened.
// It sat at b0818a across the progress/cancel work (5cf7fee) and so
// reported "current" for a pane that was two features behind.
export const TASKPANE_BUILD = "host42";

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

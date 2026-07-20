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
    throw new Error("Hasil belum berisi label per baris.");
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

async function fallbackSelectedTextContext(reason) {
  try {
    const text = await getCommonSelectedText();
    if (text.trim()) {
      return {
        host: "PowerPoint",
        text,
        meta: `PowerPoint: ${text.length} karakter dari seleksi aktif. (${reason})`
      };
    }
  } catch (_) {
    // ignore fallback failure
  }
  return {
    host: "PowerPoint",
    text: "",
    meta: `Tidak dapat membaca isi slide otomatis. ${reason}`
  };
}

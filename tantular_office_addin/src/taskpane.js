import { ACTIONS, actionsForHost, normalizeHostName } from "./prompts.js";
import { loadSettings, saveSettings, runTantular } from "./tantularClient.js";
import {
  getSelectionContext,
  getSelectedSlideTextContext,
  insertResultText,
  writeExcelLabels,
  insertDeckIntoActivePresentation
} from "./officeClient.js";
import { styleOptions } from "./deck/deckStyles.js";
import { planDeck, buildTitleSlideSpec, isThinContent, summarizeDeckSections } from "./deck/deckPlanner.js";
import { buildDeckPptxBase64 } from "./deck/pptxBuilder.js";
import { extractSlideFromImage, fileToDataUrl } from "./deck/visionExtract.js";
import { buildCapabilityMapSpec } from "./deck/capabilityMapSpec.js";
import { extractDocumentFile } from "./deck/documentExtract.js";
import { buildDocumentDeckSpec } from "./deck/documentDeck.js";

const DECK_STUDIO_BUILD = "0.9.2-insert-debug";
const PROJECT_INSTRUCTIONS_KEY = "tantular.deck.projectInstructions.v1";

const state = {
  host: "Office",
  selectedActionId: null,
  lastResult: "",
  deckSpec: null,
  extractedImageName: null,
  extractedDocumentName: null
};

const els = {
  subtitle: document.querySelector("#host-subtitle"),
  settingsToggle: document.querySelector("#settings-toggle"),
  settingsBody: document.querySelector("#settings-body"),
  endpoint: document.querySelector("#endpoint-input"),
  model: document.querySelector("#model-input"),
  visionModel: document.querySelector("#vision-model-input"),
  saveSettings: document.querySelector("#save-settings"),
  sourceText: document.querySelector("#source-text"),
  selectionMeta: document.querySelector("#selection-meta"),
  charCount: document.querySelector("#char-count"),
  loadSelection: document.querySelector("#load-selection"),
  deckStyle: document.querySelector("#deck-style"),
  deckCount: document.querySelector("#deck-count"),
  deckTone: document.querySelector("#deck-tone"),
  deckSummarize: document.querySelector("#deck-summarize"),
  deckProjectInstructions: document.querySelector("#deck-project-instructions"),
  saveProjectInstructions: document.querySelector("#save-project-instructions"),
  clearProjectInstructions: document.querySelector("#clear-project-instructions"),
  deckImageInput: document.querySelector("#deck-image-input"),
  deckDocumentInput: document.querySelector("#deck-document-input"),
  deckCreate: document.querySelector("#deck-create"),
  deckDownload: document.querySelector("#deck-download"),
  deckProgress: document.querySelector("#deck-progress"),
  deckProgressText: document.querySelector("#deck-progress-text"),
  deckPreview: document.querySelector("#deck-preview"),
  deckStatus: document.querySelector("#deck-status"),
  deckHostNote: document.querySelector("#deck-host-note"),
  actionGrid: document.querySelector("#action-grid"),
  instruction: document.querySelector("#user-instruction"),
  runAction: document.querySelector("#run-action"),
  progress: document.querySelector("#progress"),
  progressText: document.querySelector("#progress-text"),
  resultText: document.querySelector("#result-text"),
  copyResult: document.querySelector("#copy-result"),
  insertResult: document.querySelector("#insert-result"),
  classifyExcel: document.querySelector("#classify-excel"),
  status: document.querySelector("#status")
};

bootstrap();

function bootstrap() {
  bindStaticEvents();
  hydrateSettings();
  renderDeckStyleOptions();
  hydrateProjectInstructions();

  if (globalThis.Office?.onReady) {
    Office.onReady((info) => {
      state.host = normalizeHostName(info.host);
      renderForHost();
      setStatus(`Terhubung ke ${state.host}.`, "ok");
    });
  } else {
    // Browser-only preview for UI development.
    state.host = "Word";
    renderForHost();
    setStatus("Mode pratinjau browser: Office.js belum tersedia.", "");
  }
}

function bindStaticEvents() {
  els.settingsToggle.addEventListener("click", () => {
    const hidden = els.settingsBody.classList.toggle("hidden");
    els.settingsToggle.setAttribute("aria-expanded", String(!hidden));
  });

  els.saveSettings.addEventListener("click", () => {
    const saved = saveSettings({ endpoint: els.endpoint.value, model: els.model.value, visionModel: els.visionModel.value });
    els.endpoint.value = saved.endpoint;
    els.model.value = saved.model;
    els.visionModel.value = saved.visionModel;
    setStatus("Pengaturan model disimpan.", "ok");
  });

  els.sourceText.addEventListener("input", updateCharCount);
  els.loadSelection.addEventListener("click", loadSelection);
  els.runAction.addEventListener("click", runSelectedAction);
  els.copyResult.addEventListener("click", copyResult);
  els.insertResult.addEventListener("click", insertResult);
  els.classifyExcel.addEventListener("click", labelExcelRange);
  els.deckCreate.addEventListener("click", createDeckSmart);
  els.deckDownload.addEventListener("click", downloadDeckSmart);
  els.deckImageInput.addEventListener("change", () => { state.extractedImageName = null; });
  els.deckDocumentInput.addEventListener("change", () => { state.extractedDocumentName = null; });
  els.saveProjectInstructions.addEventListener("click", saveProjectInstructions);
  els.clearProjectInstructions.addEventListener("click", clearProjectInstructions);
  els.deckProjectInstructions.addEventListener("change", saveProjectInstructions);
}

function hydrateSettings() {
  const settings = loadSettings();
  els.endpoint.value = settings.endpoint;
  els.model.value = settings.model;
  els.visionModel.value = settings.visionModel;
}

function hydrateProjectInstructions() {
  els.deckProjectInstructions.value = localStorage.getItem(PROJECT_INSTRUCTIONS_KEY) || "";
}

function saveProjectInstructions() {
  localStorage.setItem(PROJECT_INSTRUCTIONS_KEY, els.deckProjectInstructions.value || "");
  setDeckStatus("Instruksi project disimpan.", "ok");
}

function clearProjectInstructions() {
  els.deckProjectInstructions.value = "";
  localStorage.removeItem(PROJECT_INSTRUCTIONS_KEY);
  setDeckStatus("Instruksi project dikosongkan.", "");
}

function projectInstructions() {
  return String(els.deckProjectInstructions.value || "").trim();
}

function combinedDeckInstructions() {
  return [projectInstructions(), els.instruction.value.trim()].filter(Boolean).join("\n\nInstruksi tambahan:\n");
}

function renderDeckStyleOptions() {
  els.deckStyle.innerHTML = styleOptions().map((style) => (
    `<option value="${escapeHtml(style.id)}">${escapeHtml(style.label)} — ${escapeHtml(style.hint)}</option>`
  )).join("");
}

function renderForHost() {
  els.subtitle.textContent = hostSubtitle(state.host);
  els.classifyExcel.classList.toggle("hidden", state.host !== "Excel");
  els.deckHostNote.textContent = state.host === "PowerPoint" ? "PowerPoint ready" : "Plan only outside PowerPoint";
  els.deckDownload.disabled = !state.deckSpec;

  const actions = actionsForHost(state.host);
  state.selectedActionId = actions[0]?.id || null;
  els.actionGrid.innerHTML = actions.map((action, index) => `
    <label class="action-option">
      <input type="radio" name="tantular-action" value="${escapeHtml(action.id)}" ${index === 0 ? "checked" : ""} />
      <span>
        <strong>${escapeHtml(action.label)}</strong>
        <small>${escapeHtml(action.description)}</small>
      </span>
    </label>
  `).join("");

  els.actionGrid.querySelectorAll("input[name='tantular-action']").forEach((input) => {
    input.addEventListener("change", () => { state.selectedActionId = input.value; });
  });
}

function hostSubtitle(host) {
  if (host === "Word") return "Word: rapikan tulisan, ringkas bagian, dan cek surat mencurigakan.";
  if (host === "Excel") return "Excel: jelaskan formula, bersihkan teks, dan labeli baris transaksi/pesan.";
  if (host === "PowerPoint") return "PowerPoint: ringkas teks slide, buat bullet, dan draft speaker notes.";
  return "Asisten privat Bahasa Indonesia untuk Microsoft 365.";
}

async function loadSelection() {
  await withProgress("Membaca seleksi Office...", async () => {
    const context = await getSelectionContext(state.host);
    els.sourceText.value = context.text;
    els.selectionMeta.textContent = context.meta;
    updateCharCount();
    setStatus(context.text ? "Seleksi berhasil dimuat." : "Seleksi kosong; tempel teks manual bila perlu.", context.text ? "ok" : "");
  });
}

async function runSelectedAction() {
  const action = ACTIONS[state.selectedActionId];
  if (!action) return setStatus("Pilih aksi terlebih dahulu.", "error");

  const rawText = els.sourceText.value.trim();
  if (!rawText) return setStatus("Masukkan atau ambil teks terlebih dahulu.", "error");

  const text = capInput(rawText, action.maxInputChars);
  const instruction = els.instruction.value.trim();
  const user = action.buildUser({ text, instruction });

  await withProgress("Menjalankan Tantular lokal...", async () => {
    const rawResult = await runTantular({
      system: action.system,
      user,
      maxTokens: state.selectedActionId === "excel_classify" ? 900 : 600,
      temperature: state.selectedActionId === "scam_check" || state.selectedActionId === "excel_classify" ? 0.05 : 0.2
    });
    const result = normalizeResultForAction(rawResult, state.selectedActionId);
    state.lastResult = result;
    els.resultText.value = result;
    setStatus(rawText.length > text.length ? `Selesai. Input dipotong ke ${text.length} karakter agar cepat.` : "Selesai.", "ok");
  });
}

// --- Deck Studio: single, predictable flow ---------------------------------
// One "source of truth" resolver + two actions (create in PowerPoint / download).

async function resolveDeckSpec() {
  const docFile = els.deckDocumentInput.files?.[0];
  const file = els.deckImageInput.files?.[0];

  // 1) If a document/PDF is uploaded, extract it first.
  if (docFile && state.extractedDocumentName !== docFile.name) {
    els.deckProgressText.textContent = "Mengekstrak dokumen/PDF...";
    const extractedDoc = await extractDocumentFile(docFile);
    els.sourceText.value = extractedDoc.text;
    els.selectionMeta.textContent = `Dokumen diekstrak: ${extractedDoc.chars} karakter dari ${extractedDoc.filename}.`;
    updateCharCount();
    state.extractedDocumentName = docFile.name;
    state.extractedImageName = null;
  }

  // 2) If an image is uploaded (and not yet extracted), OCR it once.
  if (!docFile && file && state.extractedImageName !== file.name) {
    els.deckProgressText.textContent = "Membaca gambar dengan model vision lokal...";
    const dataUrl = await fileToDataUrl(file);
    const extra = [
      els.deckTone.value.trim() ? `Tone deck: ${els.deckTone.value.trim()}` : "",
      projectInstructions()
        ? `Project/output instructions yang harus dihormati setelah ekstraksi:\n${projectInstructions()}`
        : ""
    ].filter(Boolean).join("\n\n");
    const extracted = await extractSlideFromImage(dataUrl, extra);
    els.sourceText.value = extracted;
    els.selectionMeta.textContent = `Gambar diekstrak: ${extracted.length} karakter dari ${file.name}.`;
    updateCharCount();
    state.extractedImageName = file.name;
  }

  // 3) Content priority: extracted/text box -> selected slide.
  let content = els.sourceText.value.trim();
  if (!content && state.host === "PowerPoint") {
    els.deckProgressText.textContent = "Membaca slide terpilih...";
    const selected = await getSelectedSlideTextContext();
    content = selected.text.trim();
    if (content) {
      els.sourceText.value = content;
      els.selectionMeta.textContent = selected.meta;
      updateCharCount();
    }
  }
  if (!content) {
    throw new Error("Belum ada sumber. Tempel teks di kotak atas, unggah gambar, atau pilih slide berisi teks.");
  }

  // 4) Build the plan deterministically when possible; fall back to the model.
  els.deckProgressText.textContent = "Menyusun rencana deck...";
  const count = Number(els.deckCount.value);

  const capabilitySpec = buildCapabilityMapSpec(content, count);
  if (capabilitySpec) {
    state.deckSpec = applyProjectOutputFormat(capabilitySpec, content);
    renderDeckPreview(state.deckSpec, "capability map");
    return "capability map";
  }
  if (isThinContent(content)) {
    state.deckSpec = applyProjectOutputFormat(buildTitleSlideSpec(content), content);
    renderDeckPreview(state.deckSpec, "judul rapi");
    return "thin";
  }

  // Long content (documents, PDFs, pasted reports): structure deterministically
  // by detecting headings/sections. Far cleaner than dumping raw text into a
  // small local model, which produces cut-and-paste bullets.
  const cameFromDocument = Boolean(docFile);
  if (cameFromDocument || content.length > 1600) {
    const docSpec = buildDocumentDeckSpec(content, count);
    if (docSpec) {
      const finalized = await maybeSummarize(applyProjectOutputFormat(docSpec, content));
      state.deckSpec = finalized;
      renderDeckPreview(state.deckSpec, cameFromDocument ? "struktur dokumen" : "struktur teks panjang");
      return "document";
    }
  }

  const { spec, source } = await planDeck({
    brief: content,
    slideCount: count,
    tone: els.deckTone.value.trim(),
    instruction: combinedDeckInstructions()
  });
  state.deckSpec = await maybeSummarize(applyProjectOutputFormat(spec, content));
  renderDeckPreview(state.deckSpec, source === "model" ? "Tantular" : "fallback lokal");
  return source;
}

async function maybeSummarize(spec) {
  if (!els.deckSummarize.checked) return spec;
  els.deckProgressText.textContent = "Meringkas bagian dengan Tantular...";
  return summarizeDeckSections(
    spec,
    els.deckTone.value.trim(),
    combinedDeckInstructions(),
    (done, total) => { els.deckProgressText.textContent = `Meringkas bagian ${done}/${total}...`; }
  );
}

function applyProjectOutputFormat(spec, sourceText = "") {
  const instructions = projectInstructions();
  if (!instructions || !spec?.slides?.length) return spec;

  const slides = [...spec.slides];
  const wantsSummary = /executive summary|key insight|insight|ringkasan eksekutif/i.test(instructions);
  const wantsMethodology = /methodology|metodologi|data source|data sources|sumber data/i.test(instructions);

  if (wantsSummary && !slides.some((s) => /summary|insight|ringkasan/i.test(s.headline || ""))) {
    slides.splice(1, 0, {
      type: "bullets",
      headline: "Executive Summary - Key Insights",
      bullets: deriveExecutiveSummary(spec, sourceText)
    });
  }

  if (wantsMethodology && !slides.some((s) => /methodology|metodologi|sumber data/i.test(s.headline || ""))) {
    const closingIndex = Math.max(1, slides.findIndex((s) => s.type === "closing"));
    const insertAt = closingIndex === -1 ? slides.length : closingIndex;
    slides.splice(insertAt, 0, {
      type: "bullets",
      headline: "Methodology Notes",
      bullets: [
        "Sumber utama berasal dari teks, seleksi Office, atau gambar yang diberikan pengguna.",
        "Jika gambar digunakan, OCR/vision lokal mengekstrak teks dan struktur sebelum perencanaan deck.",
        "Visualisasi dipilih mengikuti instruksi pengguna: bar untuk perbandingan, line untuk tren, heat map untuk geografi.",
        "Semua insight perlu divalidasi terhadap data sumber sebelum dipakai sebagai keputusan final."
      ]
    });
  }

  return { ...spec, slides: slides.slice(0, Math.max(slides.length, Number(els.deckCount.value) || slides.length)) };
}

function deriveExecutiveSummary(spec, sourceText) {
  const slideHeads = (spec.slides || [])
    .filter((s) => s.type !== "title" && s.type !== "closing")
    .map((s) => s.headline)
    .filter(Boolean)
    .slice(0, 4);
  const bullets = slideHeads.map((h) => `Fokus utama: ${h}.`);
  if (/security operation center|\\bSOC\\b/i.test(sourceText)) {
    bullets.unshift("Perbandingan SOC harus menyorot gap kapabilitas, proses, dan prioritas peningkatan.");
  }
  if (!bullets.length) bullets.push("Materi diringkas menjadi narasi eksekutif yang mudah dipresentasikan.");
  while (bullets.length < 3) bullets.push("Gunakan slide lanjutan untuk memvalidasi detail data dan metodologi.");
  return bullets.slice(0, 5);
}

async function createDeckSmart() {
  await withDeckProgress("Menyiapkan deck...", async () => {
    await resolveDeckSpec();
    els.deckProgressText.textContent = "Membuat file .pptx...";
    const base64 = buildDeckBase64();

    // Preferred path: insert the slides straight into the open presentation so
    // the result is visible immediately. Fall back to download outside
    // PowerPoint or when the host lacks insertSlidesFromBase64 (PowerPointApi 1.2).
    let insertFailReason = "";
    if (state.host === "PowerPoint") {
      try {
        els.deckProgressText.textContent = "Menyisipkan slide ke presentasi aktif...";
        await insertDeckIntoActivePresentation(base64);
        els.deckDownload.disabled = false;
        setDeckStatus(`${state.deckSpec.slides.length} slide disisipkan ke presentasi aktif. (${DECK_STUDIO_BUILD})`, "ok");
        return;
      } catch (error) {
        console.warn("Insert into active presentation failed; falling back to download", error);
        insertFailReason = error?.debugInfo?.message || error?.message || String(error);
        els.deckProgressText.textContent = "Sisip gagal, mengunduh .pptx...";
      }
    } else {
      insertFailReason = `host ${state.host}, bukan PowerPoint`;
    }

    triggerDeckDownload(base64);
    els.deckDownload.disabled = false;
    setDeckStatus(
      `File .pptx diunduh: ${state.deckSpec.slides.length} slide. Sisip ke presentasi gagal: ${insertFailReason} (${DECK_STUDIO_BUILD})`,
      "error"
    );
  });
}

async function downloadDeckSmart() {
  await withDeckProgress("Menyiapkan file .pptx...", async () => {
    await resolveDeckSpec();
    triggerDeckDownload();
    setDeckStatus(`File .pptx diunduh: ${state.deckSpec.slides.length} slide.`, "ok");
  });
}

function buildDeckBase64() {
  return buildDeckPptxBase64(state.deckSpec, els.deckStyle.value, projectInstructions());
}

function triggerDeckDownload(prebuilt) {
  const base64 = prebuilt || buildDeckBase64();
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFilename(state.deckSpec.title || "tantular-deck")}.pptx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function safeFilename(name) {
  return String(name || "tantular-deck")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "tantular-deck";
}

function renderDeckPreview(spec, source) {
  const slides = spec?.slides || [];
  els.deckPreview.classList.remove("hidden");
  els.deckPreview.innerHTML = `
    <strong>${escapeHtml(spec?.title || "Deck")}</strong>
    <small>Rencana: ${escapeHtml(source)} · ${slides.length} slide</small>
    <ol>
      ${slides.map((slide) => `
        <li>
          <strong>${escapeHtml(slide.headline || slide.type)}</strong>
          <small>${escapeHtml(slide.type)}${slide.subhead ? ` · ${escapeHtml(slide.subhead)}` : ""}</small>
        </li>
      `).join("")}
    </ol>
  `;
}

async function withDeckProgress(message, fn) {
  setDeckBusy(true, message);
  try {
    await fn();
  } catch (error) {
    console.error(error);
    setDeckStatus(error?.message || String(error), "error");
  } finally {
    setDeckBusy(false);
  }
}

function setDeckBusy(isBusy, message = "Menyiapkan deck...") {
  els.deckProgress.classList.toggle("hidden", !isBusy);
  els.deckProgressText.textContent = message;
  [els.deckCreate, els.deckDownload].forEach((button) => {
    button.disabled = isBusy;
  });
}

function setDeckStatus(message, kind = "") {
  els.deckStatus.textContent = message;
  els.deckStatus.className = `status ${kind}`.trim();
}

function normalizeResultForAction(result, actionId) {
  const text = String(result || "").trim();
  if (!text) return text;

  // Small local models sometimes answer slide/summary tasks as a JSON-ish array.
  // Convert that into Office-friendly bullets before the user inserts it.
  if (["word_summarize", "ppt_bullets"].includes(actionId)) {
    const parsed = tryParseStringArray(text);
    if (parsed?.length) {
      return parsed.map((item) => `- ${item.replace(/^[-•]\s*/, "")}`).join("\n");
    }
  }
  return normalizeBulletPunctuation(text);
}

function normalizeBulletPunctuation(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s*[-•]\s*[-•]\s*/, "- ")
      .replace(/^\s*--\s*/, "- ")
      .replace(/^\s*•\s*/, "- "))
    .join("\n")
    .trim();
}

function tryParseStringArray(text) {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    // Continue with a permissive fallback below.
  }

  const trimmed = text.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  return trimmed
    .slice(1, -1)
    .split(/",\s*"|'\s*,\s*'/)
    .map((part) => part.replace(/^\s*["']?/, "").replace(/["']?\s*,?\s*$/, "").trim())
    .filter(Boolean);
}

async function copyResult() {
  const text = els.resultText.value;
  if (!text.trim()) return setStatus("Belum ada hasil untuk disalin.", "error");
  await navigator.clipboard.writeText(text);
  setStatus("Hasil disalin ke clipboard.", "ok");
}

async function insertResult() {
  await withProgress("Memasukkan hasil...", async () => {
    const msg = await insertResultText(state.host, els.resultText.value);
    setStatus(msg, "ok");
  });
}

async function labelExcelRange() {
  if (state.host !== "Excel") return setStatus("Fitur ini hanya untuk Excel.", "error");
  await withProgress("Menulis label ke Excel...", async () => {
    const msg = await writeExcelLabels(els.resultText.value);
    setStatus(msg, "ok");
  });
}

async function withProgress(message, fn) {
  setBusy(true, message);
  try {
    await fn();
  } catch (error) {
    console.error(error);
    setStatus(error?.message || String(error), "error");
  } finally {
    setBusy(false);
  }
}

function setBusy(isBusy, message = "Memproses...") {
  els.progress.classList.toggle("hidden", !isBusy);
  els.progressText.textContent = message;
  [els.loadSelection, els.runAction, els.insertResult, els.classifyExcel].forEach((button) => {
    button.disabled = isBusy;
  });
}

function setStatus(message, kind = "") {
  els.status.textContent = message;
  els.status.className = `status ${kind}`.trim();
}

function updateCharCount() {
  const count = els.sourceText.value.length;
  els.charCount.textContent = `${count.toLocaleString("id-ID")} karakter`;
}

function capInput(text, maxChars) {
  if (!maxChars || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[Catatan: teks dipotong karena melewati batas MVP.]";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

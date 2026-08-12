import { ACTIONS, actionsForHost, normalizeHostName, scopedUserPrompt } from "./prompts.js";
import {
  consumeAutoSwitchNote,
  listLocalModels,
  loadSettings,
  saveSettings,
  runTantular,
  testLocalModel
} from "./tantularClient.js";
import {
  getSelectionContext,
  getSelectedSlideTextContext,
  getActivePresentationPptxFile,
  insertResultText,
  writeExcelLabels,
  insertDeckIntoActivePresentation,
  replaceSlideInActivePresentation,
  getDocumentBodyText,
  insertDocxIntoWord,
  insertMarkdownAtSelection,
  writeWorkbookSpecToExcel,
  requestedExcelChartType,
  TASKPANE_BUILD
} from "./officeClient.js";

// Keep the visible header tags in lockstep with the JS build: a hardcoded
// HTML tag went stale once and masqueraded as a caching problem.
document.querySelectorAll(".build-tag").forEach((el) => { el.textContent = TASKPANE_BUILD; });
import { styleOptions } from "./deck/deckStyles.js";
import {
  planDeck,
  buildTitleSlideSpec,
  isThinContent,
  looksLikePresentationBrief,
  inferRequestedSlideCount,
  summarizeDeckSections,
  improveExistingSlide
} from "./deck/deckPlanner.js";
import { buildDeckPptxBase64 } from "./deck/pptxBuilder.js";
import { extractSlideFromImage, fileToDataUrl, getLastOcrEngine, ocrStatusLine } from "./deck/visionExtract.js";
import { buildCapabilityMapSpec } from "./deck/capabilityMapSpec.js";
import { extractDocumentFile } from "./deck/documentExtract.js";
import { buildDocumentDeckSpec } from "./deck/documentDeck.js";
import { planDocument } from "./document/documentPlanner.js";
import { buildDocumentDocxBase64 } from "./document/docxBuilder.js";
import { planWorkbook } from "./workbook/workbookPlanner.js";
import { buildWorkbookXlsxBase64 } from "./workbook/xlsxBuilder.js";
import { hostUiConfig } from "./hostUi.js";
import { putContext, shouldAdoptServerContext } from "./workspaceClient.js";

const DECK_STUDIO_BUILD = "0.10.6-table-replace-mode";
const PROJECT_INSTRUCTIONS_KEY = "tantular.deck.projectInstructions.v1";

const state = {
  host: "Office",
  selectedActionId: null,
  lastResult: "",
  deckSpec: null,
  extractedImageName: null,
  extractedDocumentName: null,
  documentText: "",
  documentPreview: "",
  refineSpec: null,
  documentSpec: null,
  workbookSpec: null,
  lastContextUpdatedAt: null
};

const els = {
  subtitle: document.querySelector("#host-subtitle"),
  settingsToggle: document.querySelector("#settings-toggle"),
  settingsBody: document.querySelector("#settings-body"),
  endpoint: document.querySelector("#endpoint-input"),
  model: document.querySelector("#model-input"),
  deckModel: document.querySelector("#deck-model-input"),
  modelCapability: document.querySelector("#model-capability"),
  visionModel: document.querySelector("#vision-model-input"),
  apiKey: document.querySelector("#api-key-input"),
  installedModel: document.querySelector("#installed-model-select"),
  useModelGeneral: document.querySelector("#use-model-general"),
  useModelDeck: document.querySelector("#use-model-deck"),
  useTantularBoth: document.querySelector("#use-tantular-both"),
  testSelectedModel: document.querySelector("#test-selected-model"),
  refreshModels: document.querySelector("#refresh-models"),
  modelSelectionStatus: document.querySelector("#model-selection-status"),
  saveSettings: document.querySelector("#save-settings"),
  sourceText: document.querySelector("#source-text"),
  selectionMeta: document.querySelector("#selection-meta"),
  charCount: document.querySelector("#char-count"),
  loadSelection: document.querySelector("#load-selection"),
  documentStudio: document.querySelector("#document-studio"),
  documentType: document.querySelector("#document-type"),
  documentSectionCount: document.querySelector("#document-section-count"),
  documentTone: document.querySelector("#document-tone"),
  documentInstruction: document.querySelector("#document-instruction"),
  documentInsertMode: document.querySelector("#document-insert-mode"),
  documentCreate: document.querySelector("#document-create"),
  documentDownload: document.querySelector("#document-download"),
  documentProgress: document.querySelector("#document-progress"),
  documentProgressText: document.querySelector("#document-progress-text"),
  documentPreviewOutput: document.querySelector("#document-preview"),
  documentStatus: document.querySelector("#document-status"),
  sheetStudio: document.querySelector("#sheet-studio"),
  workbookType: document.querySelector("#workbook-type"),
  workbookSheetCount: document.querySelector("#workbook-sheet-count"),
  workbookInstruction: document.querySelector("#workbook-instruction"),
  workbookInsertMode: document.querySelector("#workbook-insert-mode"),
  workbookCreate: document.querySelector("#workbook-create"),
  workbookDownload: document.querySelector("#workbook-download"),
  workbookProgress: document.querySelector("#workbook-progress"),
  workbookProgressText: document.querySelector("#workbook-progress-text"),
  workbookPreview: document.querySelector("#workbook-preview"),
  workbookStatus: document.querySelector("#workbook-status"),
  deckStudio: document.querySelector("#deck-studio"),
  deckRefine: document.querySelector("#deck-refine"),
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
  refineInstruction: document.querySelector("#refine-instruction"),
  refineRun: document.querySelector("#refine-run"),
  refineDownload: document.querySelector("#refine-download"),
  refineProgress: document.querySelector("#refine-progress"),
  refineProgressText: document.querySelector("#refine-progress-text"),
  refinePreview: document.querySelector("#refine-preview"),
  refineStatus: document.querySelector("#refine-status"),
  refineHostNote: document.querySelector("#refine-host-note"),
  actionsTitle: document.querySelector("#actions-title"),
  actionWarning: document.querySelector("#action-warning"),
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
      mountWorkspaceUi();
      if (state.host === "Word" || state.host === "Excel") {
        import("./chat/chatPane.js").then(({ mountChatPane }) => mountChatPane({ host: state.host }));
      }
      // Warm up the Studio model in the background: the first Studio call
      // otherwise pays the multi-GB cold load (slow disks/RAM on workshop
      // laptops) while the user watches the spinner — or hits the fallback.
      setTimeout(() => {
        runTantular({
          system: "Balas persis: OK",
          user: "OK",
          maxTokens: 4,
          temperature: 0,
          task: "deck"
        }).catch(() => {});
      }, 4000);
    });
  } else {
    // Browser-only preview for UI development.
    const previewHost = new URLSearchParams(globalThis.location?.search || "").get("host");
    state.host = normalizeHostName(previewHost || "Word");
    renderForHost();
    setStatus("Mode pratinjau browser: Office.js belum tersedia.", "");
    mountWorkspaceUi();
    if (state.host === "Word" || state.host === "Excel") {
      import("./chat/chatPane.js").then(({ mountChatPane }) => mountChatPane({ host: state.host }));
    }
  }
}

function mountWorkspaceUi() {
  import("./workspaceUi.js").then(({ mountWorkspace }) => {
    const workspace = mountWorkspace({
      host: state.host,
      sourceTextEl: els.sourceText,
      statusEl: els.selectionMeta,
      doc: document,
      onContext: adoptServerContext
    });
    globalThis.window?.addEventListener?.("unload", () => workspace.stop?.());
  });
}

// Adopts the Companion's shared project instructions when the server copy
// is newer than the one we last applied — ordering is decided purely by
// shouldAdoptServerContext's string comparison of updated_at, never by
// comparing local/server clocks.
function adoptServerContext(context) {
  if (!shouldAdoptServerContext(context, state.lastContextUpdatedAt)) return;
  const instructions = context?.instructions || "";
  els.deckProjectInstructions.value = instructions;
  localStorage.setItem(PROJECT_INSTRUCTIONS_KEY, instructions);
  state.lastContextUpdatedAt = context.updated_at;
  setDeckStatus(`Instruksi bersama · diperbarui dari ${context.updated_by || "?"}`, "");
}

function bindStaticEvents() {
  els.settingsToggle.addEventListener("click", () => {
    const hidden = els.settingsBody.classList.toggle("hidden");
    els.settingsToggle.setAttribute("aria-expanded", String(!hidden));
  });

  els.saveSettings.addEventListener("click", () => {
    persistVisibleModelSettings("Pengaturan model disimpan dan aktif.");
  });
  els.model.addEventListener("input", renderModelCapability);
  els.deckModel.addEventListener("input", renderModelCapability);
  els.useModelGeneral.addEventListener("click", () => useInstalledModel("general"));
  els.useModelDeck.addEventListener("click", () => useInstalledModel("deck"));
  // Picking a model in the dropdown does NOT apply it — remind the user which
  // buttons do, so they don't save the old models thinking they switched.
  els.installedModel.addEventListener("change", () => {
    const picked = els.installedModel.value;
    if (!picked) return;
    if (picked !== els.model.value.trim() || picked !== els.deckModel.value.trim()) {
      setModelSelectionStatus(
        `Model "${picked}" BELUM dipakai. Klik "Pakai untuk chat" dan/atau "Pakai untuk Studio", lalu Simpan.`,
        "error"
      );
    }
  });
  els.useTantularBoth.addEventListener("click", useTantularForBoth);
  els.testSelectedModel.addEventListener("click", testSelectedModel);
  els.refreshModels.addEventListener("click", () => refreshInstalledModels(true));

  els.sourceText.addEventListener("input", updateCharCount);
  els.loadSelection.addEventListener("click", loadSelection);
  els.documentCreate.addEventListener("click", createDocumentSmart);
  els.documentDownload.addEventListener("click", downloadDocumentSmart);
  els.workbookCreate.addEventListener("click", createWorkbookSmart);
  els.workbookDownload.addEventListener("click", downloadWorkbookSmart);
  els.runAction.addEventListener("click", runSelectedAction);
  els.copyResult.addEventListener("click", copyResult);
  els.insertResult.addEventListener("click", insertResult);
  els.classifyExcel.addEventListener("click", labelExcelRange);
  els.deckCreate.addEventListener("click", createDeckSmart);
  els.deckDownload.addEventListener("click", downloadDeckSmart);
  els.refineRun.addEventListener("click", refineSelectedSlide);
  els.refineDownload.addEventListener("click", downloadRefineResult);
  // An explicit slide-count entry must never be overridden by a count parsed
  // out of the brief text.
  els.deckCount.addEventListener("input", () => { state.deckCountManual = true; });
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
  els.deckModel.value = settings.deckModel;
  els.visionModel.value = settings.visionModel;
  els.apiKey.value = settings.apiKey;
  renderModelCapability();
  refreshInstalledModels(false);
}

async function refreshInstalledModels(showStatus = false) {
  els.refreshModels.disabled = true;
  const previous = els.installedModel.value;
  els.installedModel.innerHTML = `<option value="">Memuat daftar model...</option>`;
  try {
    const models = await listLocalModels();
    const currentValues = [els.model.value, els.deckModel.value, els.visionModel.value].filter(Boolean);
    const options = [...new Set([...models, ...currentValues])];
    els.installedModel.innerHTML = options.length
      ? options.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("")
      : `<option value="">Tidak ada model Ollama</option>`;
    const preferred = [
      previous,
      "tantular-office:0.4-9b",
      ...options.filter((model) => /^tantular/i.test(model)),
      options[0]
    ].find((model) => model && options.includes(model));
    if (preferred) els.installedModel.value = preferred;
    if (showStatus) setModelSelectionStatus(`${models.length} model Ollama ditemukan. Pilih model lalu tentukan untuk chat atau semua Studio.`, "ok");
  } catch (error) {
    const fallback = [els.deckModel.value, els.model.value, els.visionModel.value].filter(Boolean);
    els.installedModel.innerHTML = [...new Set(fallback)]
      .map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
      .join("");
    if (showStatus) setModelSelectionStatus(`${error?.message || String(error)} Restart \`npm run dev\` jika server masih memakai versi lama.`, "error");
  } finally {
    els.refreshModels.disabled = false;
  }
}

function useInstalledModel(target) {
  const model = String(els.installedModel.value || "").trim();
  if (!model) return setModelSelectionStatus("Pilih model yang terpasang terlebih dahulu.", "error");
  if (target === "deck") els.deckModel.value = model;
  else els.model.value = model;
  persistVisibleModelSettings(`${model} sudah disimpan dan aktif untuk ${target === "deck" ? "Deck, Document, dan Sheet Studio" : "chat/aksi umum"}.`);
}

function useTantularForBoth() {
  const options = [...els.installedModel.options].map((option) => option.value).filter(Boolean);
  const model = options.find((name) => name === "tantular-office:0.4-9b")
    || options.find((name) => /^tantular-office:/i.test(name))
    || options.find((name) => /^tantular/i.test(name));
  if (!model) {
    return setModelSelectionStatus("Model Tantular belum ditemukan. Jalankan `npm run model:office`, lalu klik Refresh.", "error");
  }
  els.model.value = model;
  els.deckModel.value = model;
  persistVisibleModelSettings(`${model} sekarang tersimpan dan aktif untuk chat serta semua Studio.`);
}

function renderModelCapability() {
  const general = String(els.model.value || "").trim();
  const deck = String(els.deckModel.value || "").trim();
  const weakDeckModel = /\b(?:0\.[12]-id|0\.8b|1(?:\.5|\.7)?b|2b|3b|mini|small)\b/i.test(deck);
  if (weakDeckModel) {
    els.modelCapability.textContent = `⚠ Model Studio "${deck}" terlalu kecil untuk output panjang. Gunakan tantular-office:0.4-9b atau qwen3.5:9b.`;
    els.modelCapability.className = "hint model-warning";
    return;
  }
  els.modelCapability.textContent = `Model umum: ${general || "—"} · Model Studio: ${deck || "—"}. Deck, Document, dan Sheet Studio memakai model Office untuk output terstruktur.`;
  els.modelCapability.className = "hint";
}

function persistVisibleModelSettings(message) {
  const saved = saveSettings({
    endpoint: els.endpoint.value,
    model: els.model.value,
    deckModel: els.deckModel.value,
    visionModel: els.visionModel.value,
    apiKey: els.apiKey.value
  });
  els.endpoint.value = saved.endpoint;
  els.model.value = saved.model;
  els.deckModel.value = saved.deckModel;
  els.visionModel.value = saved.visionModel;
  els.apiKey.value = saved.apiKey;
  renderModelCapability();
  setModelSelectionStatus(message, "ok");
  return saved;
}

function setModelSelectionStatus(message, kind = "") {
  els.modelSelectionStatus.textContent = message;
  els.modelSelectionStatus.className = `status model-selection-status ${kind}`.trim();
}

async function testSelectedModel() {
  const model = String(els.installedModel.value || els.deckModel.value || "").trim();
  if (!model) return setModelSelectionStatus("Pilih model yang ingin dites.", "error");
  els.testSelectedModel.disabled = true;
  setModelSelectionStatus(`Menguji ${model}... cold start dapat memerlukan waktu hingga beberapa menit.`);
  try {
    const result = await testLocalModel(model);
    const seconds = Math.max(0.1, result.latencyMs / 1000).toFixed(1);
    const exact = /TANTULAR AKTIF/i.test(result.text);
    setModelSelectionStatus(
      exact
        ? `✓ ${result.model} aktif dan merespons dalam ${seconds} detik.`
        : `✓ ${result.model} merespons dalam ${seconds} detik: ${result.text.slice(0, 100)}`,
      "ok"
    );
  } catch (error) {
    setModelSelectionStatus(`Tes gagal: ${error?.message || String(error)}`, "error");
  } finally {
    els.testSelectedModel.disabled = false;
  }
}

function hydrateProjectInstructions() {
  els.deckProjectInstructions.value = localStorage.getItem(PROJECT_INSTRUCTIONS_KEY) || "";
}

async function saveProjectInstructions() {
  const instructions = els.deckProjectInstructions.value || "";
  localStorage.setItem(PROJECT_INSTRUCTIONS_KEY, instructions);
  setDeckStatus("Instruksi project disimpan.", "ok");
  try {
    const { status, body } = await putContext({ instructions, source_host: state.host });
    if (status < 200 || status >= 300) {
      setDeckStatus("tersimpan lokal; Companion tidak terjangkau", "");
      return;
    }
    if (body?.context?.updated_at) {
      state.lastContextUpdatedAt = body.context.updated_at;
    }
  } catch {
    setDeckStatus("tersimpan lokal; Companion tidak terjangkau", "");
  }
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
  if ([...els.deckStyle.options].some((option) => option.value === "custom_freeform")) {
    els.deckStyle.value = "custom_freeform";
  }
}

function renderForHost() {
  const ui = hostUiConfig(state.host);
  els.subtitle.textContent = hostSubtitle(state.host);
  els.documentStudio.classList.toggle("hidden", !ui.documentStudio);
  els.sheetStudio.classList.toggle("hidden", !ui.sheetStudio);
  els.deckStudio.classList.toggle("hidden", !ui.deckStudio);
  els.deckRefine.classList.toggle("hidden", !ui.deckRefine);
  els.classifyExcel.classList.toggle("hidden", state.host !== "Excel");
  els.deckHostNote.textContent = state.host === "PowerPoint" ? "PowerPoint ready" : "Plan only outside PowerPoint";
  els.refineHostNote.textContent = state.host === "PowerPoint" ? "PowerPoint improve" : "PowerPoint only";
  els.refineRun.disabled = state.host !== "PowerPoint";
  renderHostActionCopy();
  els.deckDownload.disabled = !state.deckSpec;
  els.refineDownload.disabled = !state.refineSpec;

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

function renderHostActionCopy() {
  const ui = hostUiConfig(state.host);
  els.actionsTitle.textContent = ui.actionsTitle;
  els.actionWarning.innerHTML = ui.actionWarning;
  els.insertResult.textContent = ui.insertLabel;
}

function hostSubtitle(host) {
  if (host === "Word") return "Word: buat dokumen DOCX, rapikan tulisan, ringkas bagian, dan cek surat mencurigakan.";
  if (host === "Excel") return "Excel: buat workbook XLSX, jelaskan formula, bersihkan teks, dan labeli baris.";
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
  if (state.host === "PowerPoint" && looksLikeDeckStudioInstruction(instruction)) {
    setStatus("Catatan: ini menjalankan Aksi cepat, bukan Deck Studio. Untuk membuat deck lengkap, scroll ke atas dan klik ✨ Buat Deck.", "error");
  }
  const user = scopedUserPrompt(action, action.buildUser({ text, instruction }));

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

function looksLikeDeckStudioInstruction(text) {
  return /\b(deck|slide count|jumlah slide|style guide|gaya desain|brand colou?r|palette|palet|visuali[sz]ation|powerpoint|pptx)\b|#[0-9a-f]{6}\b/i.test(String(text || ""));
}

// --- Document Studio --------------------------------------------------------

async function resolveDocumentSpec() {
  let content = els.sourceText.value.trim();
  if (!content && state.host === "Word") {
    els.documentProgressText.textContent = "Membaca seleksi Word...";
    const selected = await getSelectionContext("Word");
    content = selected.text.trim();
    if (!content) {
      els.documentProgressText.textContent = "Membaca isi utama dokumen...";
      content = String(await getDocumentBodyText()).trim();
    }
    if (content) {
      els.sourceText.value = content.slice(0, 12_000);
      els.selectionMeta.textContent = selected.text
        ? selected.meta
        : `Word: ${content.length} karakter dari isi utama dokumen.`;
      updateCharCount();
    }
  }
  if (!content) {
    throw new Error("Masukkan brief/teks di kotak sumber, pilih teks Word, atau buka dokumen yang berisi teks.");
  }

  els.documentProgressText.textContent = "Menyusun struktur dokumen dengan Tantular...";
  const result = await planDocument({
    brief: content.slice(0, 40_000),
    documentType: els.documentType.value,
    tone: els.documentTone.value.trim(),
    sectionCount: documentSectionCount(),
    instruction: els.documentInstruction.value.trim()
  });
  if (!result.spec) throw new Error(result.error || "Tantular tidak menghasilkan struktur dokumen.");
  state.documentSpec = result.spec;
  renderDocumentPreview(result.spec, result.source);
  return result;
}

// "Buat table untuk paragraph yang saya highlight" is a targeted transform of
// the selection, NOT a request for a whole new document. Route it away from
// the document generator, which would otherwise append unrelated sections.
function looksLikeSelectionTableRequest(text) {
  const value = String(text || "");
  return /\b(tabel|table)\b/i.test(value)
    && /\b(highlight|seleksi|selection|blok|(saya|yang di)\s*(pilih|tandai))\b/i.test(value);
}

async function convertSelectionToTable(instruction) {
  await withDocumentProgress("Membaca teks yang di-highlight...", async () => {
    const selection = await getSelectionContext("Word");
    const source = String(selection.text || "").trim();
    if (!source) {
      setDocumentStatus(
        "Instruksi meminta tabel dari teks yang di-highlight, tetapi tidak ada teks terpilih. " +
        "Blok dulu paragrafnya di dokumen, lalu klik Buat di Word lagi.",
        "error"
      );
      return;
    }

    els.documentProgressText.textContent = "Menyusun tabel dari teks terpilih...";
    const raw = await runTantular({
      system: `Anda mengubah teks menjadi SATU tabel markdown.
Aturan:
- Keluarkan HANYA tabel markdown (baris header, baris pemisah |---|, baris data). Tanpa penjelasan, tanpa markdown lain.
- Semua isi sel harus berasal dari teks sumber. Jangan menambah fakta, angka, atau kategori baru.
- Pilih kolom yang paling masuk akal dari struktur teks (mis. Aspek | Closed Model | Open-Weight, atau Poin | Penjelasan).
- Header dalam Bahasa Indonesia kecuali istilah teknis.
- Maksimum 8 baris data; ringkas isi sel seperlunya tanpa mengubah makna.`,
      user: `Instruksi pengguna: ${instruction}\n\nTeks sumber (hasil highlight):\n"""${source}"""`,
      maxTokens: 900,
      temperature: 0.1,
      task: "document"
    });

    const table = extractMarkdownTable(raw);
    if (!table) {
      throw new Error("Model tidak menghasilkan tabel yang valid. Coba lagi, atau sebutkan kolom yang diinginkan di Instruksi dokumen.");
    }

    els.documentProgressText.textContent = "Menyisipkan tabel ke Word...";
    // Honor the insert-mode dropdown: "Ganti" replaces the highlighted text
    // with the table; the safe default keeps the text and adds the table after.
    const mode = els.documentInsertMode.value === "replace" ? "replace" : "after";
    const message = await insertMarkdownAtSelection(table, mode);
    setDocumentStatus(`${message} Isi tabel hanya dari teks yang di-highlight, tanpa fakta baru.`, "ok");
  });
}

function extractMarkdownTable(raw) {
  const lines = String(raw || "").split(/\r?\n/).map((l) => l.trim());
  const start = lines.findIndex((l) => /^\|.*\|$/.test(l));
  if (start === -1) return "";
  let end = start;
  while (end + 1 < lines.length && /^\|.*\|$/.test(lines[end + 1])) end += 1;
  const block = lines.slice(start, end + 1);
  // Header + |---| separator + at least one data row.
  if (block.length < 3 || !/^\|(\s*:?-{2,}:?\s*\|)+$/.test(block[1])) return "";
  return block.join("\n");
}

async function createDocumentSmart() {
  const documentInstruction = els.documentInstruction.value.trim();
  if (state.host === "Word" && looksLikeSelectionTableRequest(documentInstruction)) {
    return convertSelectionToTable(documentInstruction);
  }
  await withDocumentProgress("Menyiapkan dokumen Word...", async () => {
    const result = await resolveDocumentSpec();
    els.documentProgressText.textContent = "Membuat file .docx...";
    const base64 = buildCurrentDocumentBase64();
    if (state.host === "Word") {
      try {
        els.documentProgressText.textContent = "Memasukkan dokumen ke Word...";
        const message = await insertDocxIntoWord(base64, els.documentInsertMode.value);
        setDocumentStatus(`${message} Struktur: ${result.source === "model" ? "Tantular" : "fallback lokal"}.`, "ok");
        return;
      } catch (error) {
        triggerDocumentDownload(base64);
        setDocumentStatus(`Sisip ke Word gagal; file .docx diunduh. ${error?.message || String(error)}`, "error");
        return;
      }
    }
    triggerDocumentDownload(base64);
    setDocumentStatus("File .docx diunduh.", "ok");
  });
}

async function downloadDocumentSmart() {
  await withDocumentProgress("Menyiapkan file .docx...", async () => {
    await resolveDocumentSpec();
    triggerDocumentDownload();
    setDocumentStatus("File .docx diunduh.", "ok");
  });
}

function buildCurrentDocumentBase64() {
  if (!state.documentSpec) throw new Error("Belum ada dokumen untuk dibuat.");
  const color = els.documentInstruction.value.match(/#[0-9a-f]{6}\b/i)?.[0] || "#A6351D";
  return buildDocumentDocxBase64(state.documentSpec, { accent: color });
}

function triggerDocumentDownload(prebuilt) {
  const base64 = prebuilt || buildCurrentDocumentBase64();
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFilename(state.documentSpec?.title || "tantular-document")}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderDocumentPreview(spec, source) {
  const sections = spec.sections || [];
  els.documentPreviewOutput.classList.remove("hidden");
  els.documentPreviewOutput.innerHTML = `
    <strong>${escapeHtml(spec.title || "Dokumen")}</strong>
    <small>Struktur: ${escapeHtml(source === "model" ? "Tantular" : "fallback lokal")} · ${sections.length} bagian</small>
    <ol>
      ${sections.map((section) => `
        <li>
          <strong>${escapeHtml(section.heading || "Bagian")}</strong>
          <small>${section.paragraphs?.length || 0} paragraf · ${section.bullets?.length || 0} bullet</small>
        </li>
      `).join("")}
    </ol>
  `;
}

function documentSectionCount() {
  const value = Math.round(Number(els.documentSectionCount.value) || 6);
  const clamped = Math.min(12, Math.max(3, value));
  els.documentSectionCount.value = String(clamped);
  return clamped;
}

async function withDocumentProgress(message, fn) {
  setDocumentBusy(true, message);
  try {
    await fn();
  } catch (error) {
    console.error(error);
    setDocumentStatus(error?.message || String(error), "error");
  } finally {
    setDocumentBusy(false);
  }
}

function setDocumentBusy(isBusy, message = "Menyusun dokumen...") {
  els.documentProgress.classList.toggle("hidden", !isBusy);
  els.documentProgressText.textContent = message;
  els.documentCreate.disabled = isBusy;
  els.documentDownload.disabled = isBusy;
}

function setDocumentStatus(message, kind = "") {
  els.documentStatus.textContent = message;
  els.documentStatus.className = `status ${kind}`.trim();
}

// --- Sheet Studio -----------------------------------------------------------

async function resolveWorkbookSpec() {
  let content = els.sourceText.value.trim();
  if (!content && state.host === "Excel") {
    els.workbookProgressText.textContent = "Membaca range Excel...";
    const selected = await getSelectionContext("Excel");
    content = selected.text.trim();
    if (content) {
      els.sourceText.value = content;
      els.selectionMeta.textContent = selected.meta;
      updateCharCount();
    }
  }
  if (!content) {
    throw new Error("Masukkan brief/teks di kotak sumber atau pilih range Excel terlebih dahulu.");
  }

  els.workbookProgressText.textContent = "Menyusun struktur workbook dengan Tantular...";
  const result = await planWorkbook({
    brief: content.slice(0, 40_000),
    workbookType: els.workbookType.value,
    sheetCount: workbookSheetCount(),
    instruction: els.workbookInstruction.value.trim()
  });
  if (!result.spec) throw new Error(result.error || "Tantular tidak menghasilkan struktur workbook.");
  state.workbookSpec = result.spec;
  renderWorkbookPreview(result.spec, result.source);
  return result;
}

async function createWorkbookSmart() {
  await withWorkbookProgress("Menyiapkan workbook Excel...", async () => {
    const result = await resolveWorkbookSpec();
    if (state.host === "Excel") {
      try {
        els.workbookProgressText.textContent = "Membuat sheet di Excel...";
        const message = await writeWorkbookSpecToExcel(state.workbookSpec, els.workbookInsertMode.value, {
          // "tolong dibuatkan chart/grafik" harus menghasilkan chart sungguhan.
          chartType: requestedExcelChartType(els.workbookInstruction.value)
        });
        setWorkbookStatus(`${message} Struktur: ${result.source === "model" ? "Tantular" : "fallback lokal"}.`, "ok");
        return;
      } catch (error) {
        triggerWorkbookDownload();
        setWorkbookStatus(`Tulis ke Excel gagal; file .xlsx diunduh. ${error?.message || String(error)}`, "error");
        return;
      }
    }
    triggerWorkbookDownload();
    setWorkbookStatus("File .xlsx diunduh.", "ok");
  });
}

async function downloadWorkbookSmart() {
  await withWorkbookProgress("Menyiapkan file .xlsx...", async () => {
    await resolveWorkbookSpec();
    triggerWorkbookDownload();
    setWorkbookStatus("File .xlsx diunduh.", "ok");
  });
}

function buildCurrentWorkbookBase64() {
  if (!state.workbookSpec) throw new Error("Belum ada workbook untuk dibuat.");
  const color = els.workbookInstruction.value.match(/#[0-9a-f]{6}\b/i)?.[0] || "#1F3A5F";
  return buildWorkbookXlsxBase64(state.workbookSpec, { accent: color });
}

function triggerWorkbookDownload() {
  const base64 = buildCurrentWorkbookBase64();
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFilename(state.workbookSpec?.title || "tantular-workbook")}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderWorkbookPreview(spec, source) {
  const sheets = spec.sheets || [];
  els.workbookPreview.classList.remove("hidden");
  els.workbookPreview.innerHTML = `
    <strong>${escapeHtml(spec.title || "Workbook")}</strong>
    <small>Struktur: ${escapeHtml(source === "model" ? "Tantular" : "fallback lokal")} · ${sheets.length} sheet</small>
    <ol>
      ${sheets.map((sheet) => `
        <li>
          <strong>${escapeHtml(sheet.name || "Sheet")}</strong>
          <small>${sheet.columns?.length || 0} kolom · ${sheet.rows?.length || 0} baris</small>
        </li>
      `).join("")}
    </ol>
  `;
}

function workbookSheetCount() {
  const value = Math.round(Number(els.workbookSheetCount.value) || 2);
  const clamped = Math.min(8, Math.max(1, value));
  els.workbookSheetCount.value = String(clamped);
  return clamped;
}

async function withWorkbookProgress(message, fn) {
  setWorkbookBusy(true, message);
  try {
    await fn();
  } catch (error) {
    console.error(error);
    setWorkbookStatus(error?.message || String(error), "error");
  } finally {
    setWorkbookBusy(false);
  }
}

function setWorkbookBusy(isBusy, message = "Menyusun workbook...") {
  els.workbookProgress.classList.toggle("hidden", !isBusy);
  els.workbookProgressText.textContent = message;
  els.workbookCreate.disabled = isBusy;
  els.workbookDownload.disabled = isBusy;
}

function setWorkbookStatus(message, kind = "") {
  els.workbookStatus.textContent = message;
  els.workbookStatus.className = `status ${kind}`.trim();
}

// --- Deck Studio: single, predictable flow ---------------------------------
// One "source of truth" resolver + two actions (create in PowerPoint / download).

function documentPreview(text, chars) {
  const head = String(text || "").slice(0, 1000).trimEnd();
  return `[Pratinjau dokumen — teks lengkap ${chars} karakter dipakai saat membuat deck. Edit kotak ini hanya jika ingin mengganti sumbernya.]\n\n${head}…`;
}

async function resolveDeckSpec() {
  state.deckPlanWarning = "";
  state.deckAutoSwitchNote = "";
  const docFile = els.deckDocumentInput.files?.[0];
  const file = els.deckImageInput.files?.[0];

  // 1) If a document/PDF is uploaded, extract it first. Keep the full text in
  // memory only — the textarea gets a short preview so the pane stays light
  // and the full document is never re-rendered or re-used as pasted input.
  if (docFile && state.extractedDocumentName !== docFile.name) {
    els.deckProgressText.textContent = "Mengekstrak dokumen/PDF...";
    const extractedDoc = await extractDocumentFile(docFile);
    state.documentText = extractedDoc.text;
    state.documentPreview = documentPreview(extractedDoc.text, extractedDoc.chars);
    els.sourceText.value = state.documentPreview;
    els.selectionMeta.textContent = `Dokumen diekstrak: ${extractedDoc.chars} karakter dari ${extractedDoc.filename}. Pratinjau singkat ditampilkan; teks lengkap dipakai saat membuat deck.`;
    updateCharCount();
    state.extractedDocumentName = docFile.name;
    state.extractedImageName = null;
  }

  // 2) If an image is uploaded (and not yet extracted), OCR it once.
  if (!docFile && file && state.extractedImageName !== file.name) {
    els.deckProgressText.textContent = "Membaca teks dari gambar...";
    const dataUrl = await fileToDataUrl(file);
    const extra = [
      els.deckTone.value.trim() ? `Tone deck: ${els.deckTone.value.trim()}` : "",
      projectInstructions()
        ? `Project/output instructions yang harus dihormati setelah ekstraksi:\n${projectInstructions()}`
        : ""
    ].filter(Boolean).join("\n\n");
    const extracted = await extractSlideFromImage(dataUrl, extra);
    els.sourceText.value = extracted;
    els.selectionMeta.textContent = `Gambar diekstrak: ${extracted.length} karakter dari ${file.name} — ${ocrStatusLine(getLastOcrEngine())}.`;
    updateCharCount();
    state.extractedImageName = file.name;
  }

  // 3) Content priority: extracted document (full text) -> text box -> selected
  // slide. The document's full text is used only while the textarea still shows
  // its untouched preview; editing the box hands control back to the user.
  let content = els.sourceText.value.trim();
  if (
    docFile &&
    state.extractedDocumentName === docFile.name &&
    state.documentText &&
    content === state.documentPreview.trim()
  ) {
    content = state.documentText.trim();
  }
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
  if (!projectInstructions() && looksLikeDeckStudioInstruction(content)) {
    setDeckStatus("Catatan: kotak Teks/seleksi terlihat seperti style guide. Untuk hasil terbaik, taruh brief/konten utama di Teks/seleksi dan style guide di Project/output instructions.", "error");
  }

  // 4) Build the plan deterministically when possible; fall back to the model.
  els.deckProgressText.textContent = "Menyusun rencana deck...";
  // The count typed by the user always wins; the number parsed from the brief
  // only fills in when the field was never touched. Without this, a brief
  // saying "buat 20 slide" silently overrides an explicit smaller request.
  const requestedCount = state.deckCountManual ? 0 : inferRequestedSlideCount(content);
  if (requestedCount) {
    els.deckCount.value = String(requestedCount);
    els.selectionMeta.textContent = `${els.selectionMeta.textContent || "Sumber siap."} Permintaan ${requestedCount} slide terdeteksi dari brief.`;
  }
  const count = requestedCount || deckSlideCount();

  const capabilitySpec = buildCapabilityMapSpec(content, count);
  if (capabilitySpec) {
    state.deckSpec = applyProjectOutputFormat(capabilitySpec, content);
    renderDeckPreview(state.deckSpec, "capability map");
    return "capability map";
  }
  if (isThinContent(content) && !looksLikePresentationBrief(content)) {
    state.deckSpec = applyProjectOutputFormat(buildTitleSlideSpec(content), content);
    renderDeckPreview(state.deckSpec, "judul rapi");
    return "thin";
  }

  // Long content (documents, PDFs, pasted reports): structure deterministically
  // by detecting headings/sections. Far cleaner than dumping raw text into a
  // small local model, which produces cut-and-paste bullets.
  const cameFromDocument = Boolean(docFile);
  if (cameFromDocument || (content.length > 1600 && !looksLikePresentationBrief(content))) {
    const docSpec = buildDocumentDeckSpec(content, count);
    if (docSpec) {
      const finalized = await maybeSummarize(applyProjectOutputFormat(docSpec, content));
      state.deckSpec = finalized;
      // Say so when the document can't fill the requested count — a silent
      // 6-of-20 result reads as a glitch to the user.
      const got = finalized.slides?.length || 0;
      const baseLabel = cameFromDocument ? "struktur dokumen" : "struktur teks panjang";
      renderDeckPreview(
        state.deckSpec,
        got < count ? `${baseLabel} · ${got}/${count} slide — konten sumber tidak cukup untuk ${count} slide` : baseLabel
      );
      return "document";
    }
  }

  const { spec, source, error: planError } = await planDeck({
    brief: content,
    slideCount: count,
    tone: els.deckTone.value.trim(),
    instruction: combinedDeckInstructions()
  });
  state.deckSpec = await maybeSummarize(applyProjectOutputFormat(spec, content));
  renderDeckPreview(state.deckSpec, source === "model" ? "Tantular" : "fallback lokal");
  // A fallback deck must never look like a successful model run: it chunks the
  // brief verbatim and reads as garbage. Record it so the final status warns.
  state.deckPlanWarning = source === "model"
    ? ""
    : `⚠️ Model Studio tidak merespons${planError ? ` (${planError})` : ""}; deck disusun penyusun sederhana, bukan model. Buka Pengaturan model lokal → Tes model terpilih, pastikan Ollama + Companion berjalan, lalu buat ulang deck.`;
  state.deckAutoSwitchNote = consumeAutoSwitchNote();
  if (state.deckAutoSwitchNote) hydrateSettings();
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

  return { ...spec, slides: slides.slice(0, Math.max(slides.length, deckSlideCount())) };
}

function deckSlideCount() {
  const raw = Number(els.deckCount.value);
  const value = Number.isFinite(raw) ? Math.round(raw) : 12;
  const clamped = Math.min(30, Math.max(3, value || 12));
  if (String(clamped) !== String(els.deckCount.value).trim()) {
    els.deckCount.value = String(clamped);
  }
  return clamped;
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
        if (state.deckPlanWarning) {
          setDeckStatus(`${state.deckSpec.slides.length} slide disisipkan, TETAPI: ${state.deckPlanWarning}`, "error");
        } else {
          const switchNote = state.deckAutoSwitchNote ? ` · ℹ️ ${state.deckAutoSwitchNote}` : "";
          setDeckStatus(`${state.deckSpec.slides.length} slide disisipkan ke presentasi aktif. (${DECK_STUDIO_BUILD})${switchNote}`, "ok");
        }
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
      `File .pptx diunduh: ${state.deckSpec.slides.length} slide. Sisip ke presentasi gagal: ${insertFailReason} (${DECK_STUDIO_BUILD})${state.deckPlanWarning ? ` — ${state.deckPlanWarning}` : ""}`,
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

// --- Improve Existing Deck: selected-slide repair ---------------------------

async function refineSelectedSlide() {
  if (state.host !== "PowerPoint") {
    return setRefineStatus("Improve Existing Deck hanya tersedia di PowerPoint.", "error");
  }

  await withRefineProgress("Membaca slide terpilih...", async () => {
    resetRefineOutput();
    const instruction = refineInstructionBundle();
    const selected = await getSelectedSlideTextContext();
    let slideText = selected.text.trim();
    const knowsSlide = Boolean(selected.slideIds?.length || selected.slideIndexes?.length);
    // A text selection is only a fragment of the slide; improving from a
    // fragment produces thin, low-quality slides. Whenever we know WHICH slide
    // is targeted, read its FULL text from the active deck instead.
    if (!slideText || (selected.partialSelection && knowsSlide)) {
      els.refineProgressText.textContent = "Membaca teks lengkap slide dari active deck...";
      const fullText = await activeDeckSlideTextFallback(selected, instruction);
      if (fullText) slideText = fullText;
    }
    if (!slideText) {
      throw new Error(
        "Tidak ada teks yang bisa dipetakan dengan aman ke slide terpilih. " +
        "Jika slide berupa gambar murni atau PowerPoint tidak mengekspos ID slide, " +
        "pilih teks di dalam slide, pakai Deck Studio image source, atau tempel deskripsi slide di Teks/seleksi."
      );
    }

    const tone = els.deckTone.value.trim();

    els.refineProgressText.textContent = "Menyusun versi slide yang lebih baik...";
    const result = await improveExistingSlide({ slideText, tone, instruction });

    if (!result?.spec) {
      throw new Error("Tantular belum dapat memperbaiki slide ini. Pastikan slide berisi teks yang bisa dibaca.");
    }

    state.refineSpec = result.spec;
    renderRefinePreview(state.refineSpec, result.source || "source-grounded");
    els.refineDownload.disabled = false;

    els.refineProgressText.textContent = "Mengganti slide terpilih dengan versi improved...";
    const base64 = buildRefineBase64();
    try {
      // Replace IN PLACE: insert after the original, then delete the original,
      // so the improvement lands on the same page instead of piling up as
      // extra slides. Target comes from the live selection, the extractor
      // fallback match, or an explicit "slide #N" in the instruction.
      const outcome = await replaceSlideInActivePresentation(base64, {
        slideId: selected.slideIds?.[0] || state.refineTargetSlideId || "",
        slideIndex: selected.slideIndexes?.[0] || state.refineTargetSlideIndex || extractRequestedSlideIndex(instruction),
        // Improve Existing Deck should feel like a refinement of the current
        // deck, not a separate imported deck theme.
        formatting: "UseDestinationTheme"
      });
      if (outcome.replaced) {
        setRefineStatus(`Slide terpilih diganti dengan versi improved (posisi sama). Output dijaga source-grounded: tidak menambah angka/fakta baru. (${DECK_STUDIO_BUILD})`, "ok");
      } else {
        setRefineStatus(`Improved slide disisipkan setelah slide asli, tetapi slide asli tidak bisa dihapus otomatis: ${outcome.reason || "alasan tidak diketahui"}. Hapus slide lama secara manual.`, "error");
      }
    } catch (error) {
      triggerSpecDownload(base64, state.refineSpec);
      setRefineStatus(`Ganti slide gagal; improved slide diunduh sebagai .pptx. ${error?.message || String(error)}`, "error");
    }
  });
}

async function activeDeckSlideTextFallback(selectedContext, instruction = "") {
  const activeFile = await getActivePresentationPptxFile();
  const extracted = await extractDocumentFile(activeFile);
  const text = String(extracted.text || "").trim();
  if (!text) return "";

  const slideIds = selectedContext?.slideIds || [];
  const slideIndexes = selectedContext?.slideIndexes || [];
  const requestedIndex = extractRequestedSlideIndex(instruction);
  const byId = extractPptxSlides(text);
  // Remember which slide the fallback matched so the replace step can target
  // the same page even though the live selection exposed no usable ids.
  const rememberTarget = (match) => {
    state.refineTargetSlideId = match.id || "";
    state.refineTargetSlideIndex = Number(match.index) || 0;
  };
  for (const id of slideIds) {
    const match = byId.find((slide) => slide.id && String(slide.id) === String(id));
    if (match?.text?.trim()) {
      rememberTarget(match);
      setRefineStatus(`Teks slide dibaca dari active deck fallback (${match.label}).`, "ok");
      return match.text.trim();
    }
  }

  for (const index of slideIndexes) {
    const match = byId.find((slide) => Number(slide.index) === Number(index));
    if (match?.text?.trim()) {
      rememberTarget(match);
      setRefineStatus(`Teks slide dibaca dari active deck fallback (${match.label}, berdasarkan indeks slide terpilih).`, "ok");
      return match.text.trim();
    }
  }

  if (requestedIndex) {
    const match = byId.find((slide) => Number(slide.index) === Number(requestedIndex));
    if (match?.text?.trim()) {
      rememberTarget(match);
      setRefineStatus(`Teks slide dibaca dari active deck fallback (${match.label}, berdasarkan instruksi page/slide #${requestedIndex}).`, "ok");
      return match.text.trim();
    }
  }

  if (byId.length === 1 && byId[0]?.text?.trim()) {
    rememberTarget(byId[0]);
    setRefineStatus("Teks slide dibaca dari active deck fallback (deck hanya berisi 1 slide).", "ok");
    return byId[0].text.trim();
  }

  // IMPORTANT: never fall back to dumping the whole deck as "source". Doing so
  // makes Tantular "improve" a DIFFERENT slide (it picks content from unrelated
  // slides), which reads as hallucination to the user. If we cannot positively
  // map the selected slide, refuse and ask the user to target it explicitly.
  setRefineStatus(
    "Tidak bisa memetakan slide terpilih ke teks yang terbaca (slide ini kemungkinan berbasis gambar). " +
    "Agar tidak salah slide, Tantular tidak memakai isi deck lain sebagai sumber. " +
    "Pilih teks di dalam slide, atau tempel deskripsi/isi slide ke kotak Teks/seleksi, lalu coba lagi.",
    "error"
  );
  return "";
}

function extractRequestedSlideIndex(text) {
  const value = String(text || "");
  const match = value.match(/\b(?:slide|page|halaman|hlm|deck\s*page)\s*#?\s*(\d{1,3})\b/i)
    || value.match(/#\s*(\d{1,3})\b/);
  if (!match) return 0;
  const index = Number(match[1]);
  return Number.isInteger(index) && index > 0 ? index : 0;
}

function extractPptxSlides(text) {
  const value = String(text || "");
  const re = /^\[Slide\s+(\d+)(?:\s+\|\s+id\s+([^\]]+))?\]\s*\n([\s\S]*?)(?=^\[Slide\s+\d+(?:\s+\|\s+id\s+[^\]]+)?\]\s*\n|\s*$)/gm;
  const slides = [];
  let match;
  while ((match = re.exec(value))) {
    slides.push({
      label: `Slide ${match[1]}${match[2] ? ` | id ${match[2]}` : ""}`,
      index: match[1],
      id: match[2] || "",
      text: match[3].trim()
    });
  }
  return slides;
}

function refineInstructionBundle() {
  return [
    projectInstructions() ? `Project/style guide:\n${projectInstructions()}` : "",
    els.refineInstruction.value.trim() ? `Instruksi improvement:\n${els.refineInstruction.value.trim()}` : ""
  ].filter(Boolean).join("\n\n");
}

async function downloadRefineResult() {
  if (!state.refineSpec) return setRefineStatus("Belum ada improved slide untuk diunduh.", "error");
  const base64 = buildRefineBase64();
  triggerSpecDownload(base64, state.refineSpec);
  setRefineStatus("Improved slide .pptx diunduh.", "ok");
}

function resetRefineOutput() {
  state.refineSpec = null;
  state.refineTargetSlideId = "";
  state.refineTargetSlideIndex = 0;
  els.refineDownload.disabled = true;
  els.refinePreview.classList.add("hidden");
  els.refinePreview.innerHTML = "";
}

function buildDeckBase64() {
  return buildDeckPptxBase64(state.deckSpec, els.deckStyle.value, deckStyleHints());
}

function buildRefineBase64() {
  return buildDeckPptxBase64(state.refineSpec, els.deckStyle.value, deckStyleHints());
}

// Style hints (brand colors, chart/format rules) should come from the Project /
// output instructions box. But users often paste them into the top source box
// by mistake, so fall back to scanning the source text for hex colors too.
function deckStyleHints() {
  const project = projectInstructions();
  const source = String(els.sourceText.value || "");
  const hasHex = /#[0-9a-fA-F]{6}\b/.test(project);
  if (project && hasHex) return project;
  const sourceHasHex = /#[0-9a-fA-F]{6}\b/.test(source);
  if (!project && sourceHasHex) return source;
  if (project && !hasHex && sourceHasHex) return `${project}\n${source}`;
  return project;
}

function triggerDeckDownload(prebuilt) {
  const base64 = prebuilt || buildDeckBase64();
  triggerSpecDownload(base64, state.deckSpec);
}

function triggerSpecDownload(base64, spec) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeFilename(spec?.title || "tantular-deck")}.pptx`;
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
  renderDeckSpecPreview(els.deckPreview, spec, source);
}

function renderRefinePreview(spec, source) {
  renderDeckSpecPreview(els.refinePreview, spec, source);
}

function renderDeckSpecPreview(container, spec, source) {
  const slides = spec?.slides || [];
  container.classList.remove("hidden");
  container.innerHTML = `
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

async function withRefineProgress(message, fn) {
  setRefineBusy(true, message);
  try {
    await fn();
  } catch (error) {
    console.error(error);
    setRefineStatus(error?.message || String(error), "error");
  } finally {
    setRefineBusy(false);
  }
}

function setRefineBusy(isBusy, message = "Menyiapkan improvement...") {
  els.refineProgress.classList.toggle("hidden", !isBusy);
  els.refineProgressText.textContent = message;
  els.refineRun.disabled = isBusy || state.host !== "PowerPoint";
  els.refineDownload.disabled = isBusy || !state.refineSpec;
}

function setRefineStatus(message, kind = "") {
  els.refineStatus.textContent = message;
  els.refineStatus.className = `status ${kind}`.trim();
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

import { routeIntent, defaultContextFor } from "./intentRouter.js";
import { createHistory } from "./history.js";
import { getPipeline } from "./pipelines/index.js";
import { getSelectionContext } from "../officeClient.js";
import { actionsForHost } from "../prompts.js";

const CONTEXT_LABELS = { selection: "Seleksi", document: "Dokumen (isi utama)", none: "Tanpa konteks" };
const CONTEXT_ORDER = [null, "selection", "document", "none"];

export function mountChatPane({ host }) {
  const card = document.querySelector("#chat-card");
  if (!card || host !== "Word") return;
  card.classList.remove("hidden");

  const els = {
    messages: card.querySelector("#chat-messages"),
    input: card.querySelector("#chat-input"),
    send: card.querySelector("#chat-send"),
    stop: card.querySelector("#chat-stop"),
    pill: card.querySelector("#chat-context-pill"),
    chips: card.querySelector("#chat-chips")
  };
  const history = createHistory({ maxChars: 6000 });
  const state = { contextOverride: null, abort: null, busy: false };

  renderChips();
  setPill(null);

  els.send.addEventListener("click", () => send());
  els.stop.addEventListener("click", () => state.abort?.abort());
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  els.pill.addEventListener("click", () => {
    const current = state.contextOverride;
    const next = CONTEXT_ORDER[(CONTEXT_ORDER.indexOf(current) + 1) % CONTEXT_ORDER.length];
    state.contextOverride = next;
    setPill(next);
  });

  function renderChips() {
    // Word-applicable existing actions become quick prompts (spec: Word only).
    const prompts = {
      word_rewrite: "Perbaiki bahasa teks yang saya pilih.",
      word_summarize: "Ringkas teks yang saya pilih.",
      scam_check: "Cek apakah teks yang saya pilih berisiko penipuan.",
      ppt_bullets: "Ubah teks yang saya pilih menjadi bullet slide.",
      text_cleanup: "Bersihkan dan standarkan teks yang saya pilih."
    };
    for (const action of actionsForHost("Word")) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chat-chip";
      chip.textContent = action.label;
      chip.addEventListener("click", () => {
        els.input.value = prompts[action.id] ?? action.label;
        els.input.focus();
      });
      els.chips.appendChild(chip);
    }
  }

  function setPill(mode) {
    els.pill.textContent = `Konteks: ${mode ? CONTEXT_LABELS[mode] : "otomatis"}`;
  }

  function addBubble(cls, text = "") {
    const div = document.createElement("div");
    div.className = `chat-bubble ${cls}`;
    div.textContent = text;
    els.messages.appendChild(div);
    els.messages.scrollTop = els.messages.scrollHeight;
    return div;
  }

  async function gatherContext(mode) {
    if (mode === "none") return { text: "", label: "none" };
    if (mode === "selection") {
      const selection = await getSelectionContext("Word");
      return { text: selection.text ?? "", label: "selection" };
    }
    // "document" — Stage 1A has no doc reader yet; Task 7 swaps this in.
    const { buildDocumentContext } = await import("./contextBuilder.js").catch(() => ({}));
    if (!buildDocumentContext) return { text: "", label: "none" };
    return { text: await buildDocumentContext({ emitProgress: (msg) => setBusyNote(msg) }), label: "document" };
  }

  let busyNote = null;
  function setBusyNote(text) {
    if (!busyNote) busyNote = addBubble("assistant", "");
    busyNote.textContent = text;
  }

  async function send() {
    const message = els.input.value.trim();
    if (!message || state.busy) return;
    state.busy = true;
    els.input.value = "";
    els.send.classList.add("hidden");
    els.stop.classList.remove("hidden");
    addBubble("user", message);
    history.add("user", message);
    const answer = addBubble("assistant", "");
    state.abort = new AbortController();
    try {
      const intent = await routeIntent(message);
      const selection = await getSelectionContext("Word");
      const hasSelection = Boolean(selection.text?.trim());
      const mode = state.contextOverride ?? defaultContextFor(intent, hasSelection);
      setPill(mode);
      const context = mode === "selection"
        ? { text: selection.text ?? "" }
        : await gatherContext(mode);
      const tag = document.createElement("span");
      tag.className = "intent-tag";
      tag.textContent = `${intent} · ${CONTEXT_LABELS[mode]}`;
      answer.prepend(tag);
      const result = await getPipeline(intent)({
        instruction: message,
        contextText: context.text,
        history,
        emit: (token) => {
          answer.append(token);
          els.messages.scrollTop = els.messages.scrollHeight;
        },
        signal: state.abort.signal
      });
      if (result.kind === "edits") {
        let renderEditPreview;
        try {
          ({ renderEditPreview } = await import("./wordEdits.js"));
        } catch {
          addBubble("error", "Fitur edit belum tersedia di build ini.");
          return;
        }
        renderEditPreview({ container: els.messages, edits: result.edits, addBubble });
      }
      // kind === "text" needs nothing extra: tokens were already streamed
      // into the bubble via emit().
      history.add("assistant", result.kind === "text" ? result.text : JSON.stringify(result.edits));
    } catch (error) {
      if (String(error?.message) === "dihentikan") {
        answer.append(" (dihentikan)");
        if (error.partialText) history.add("assistant", error.partialText);
      } else {
        addBubble("error", String(error?.message ?? error));
      }
    } finally {
      busyNote = null;
      state.busy = false;
      state.abort = null;
      els.send.classList.remove("hidden");
      els.stop.classList.add("hidden");
    }
  }
}

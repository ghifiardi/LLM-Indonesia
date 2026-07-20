import { routeIntent, defaultContextFor } from "./intentRouter.js";
import { createHistory } from "./history.js";
import { getPipeline } from "./pipelines/index.js";
import { getSelectionContext, insertResultText } from "../officeClient.js";
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

  async function gatherContext(mode, signal) {
    if (mode === "none") return { text: "", label: "none" };
    if (mode === "selection") {
      const selection = await getSelectionContext("Word");
      return { text: selection.text ?? "", label: "selection" };
    }
    // "document" — Stage 1A has no doc reader yet; Task 7 swaps this in.
    const { buildDocumentContext } = await import("./contextBuilder.js").catch(() => ({}));
    if (!buildDocumentContext) return { text: "", label: "none" };
    return { text: await buildDocumentContext({ emitProgress: (msg) => setBusyNote(msg), signal }), label: "document" };
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
    const priorMessages = history.toMessages();
    history.add("user", message);
    const answer = addBubble("assistant", "");
    state.abort = new AbortController();
    try {
      const intent = await routeIntent(message, { signal: state.abort.signal });
      const selection = await getSelectionContext("Word");
      const hasSelection = Boolean(selection.text?.trim());
      const mode = state.contextOverride ?? defaultContextFor(intent, hasSelection);
      setPill(mode);
      const context = mode === "selection"
        ? { text: selection.text ?? "" }
        : await gatherContext(mode, state.abort.signal);
      const tag = document.createElement("span");
      tag.className = "intent-tag";
      tag.textContent = `${intent} · ${CONTEXT_LABELS[mode]}`;
      answer.prepend(tag);
      let emitted = 0;
      const result = await getPipeline(intent)({
        instruction: message,
        contextText: context.text,
        history: { toMessages: () => priorMessages },
        emit: (token) => {
          emitted += 1;
          answer.append(token);
          els.messages.scrollTop = els.messages.scrollHeight;
        },
        signal: state.abort.signal
      });
      // Some pipelines (TERJEMAH/UBAH_NADA/CEK_AMAN/RINGKAS…) short-circuit
      // with a guidance text (e.g. "Pilih teks…dulu") WITHOUT ever calling
      // emit — render it now or the bubble stays blank under the intent tag.
      if (result.kind === "text" && emitted === 0 && result.text) {
        answer.append(result.text);
      }
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
      if (result.kind === "text" && intent === "DRAFT_TEKS" && result.text) {
        const insertBtn = document.createElement("button");
        insertBtn.type = "button";
        insertBtn.className = "chat-chip";
        insertBtn.textContent = "Sisipkan ke dokumen";
        insertBtn.addEventListener("click", async () => {
          insertBtn.disabled = true;
          try {
            await insertResultText("Word", result.text);
            addBubble("assistant", "Teks disisipkan di posisi kursor.");
          } catch (error) {
            addBubble("error", String(error?.message ?? error));
            insertBtn.disabled = false;
          }
        });
        els.messages.appendChild(insertBtn);
      }
      history.add("assistant", result.kind === "text" ? result.text : JSON.stringify(result.edits));
    } catch (error) {
      if (String(error?.message) === "dihentikan" || state.abort?.signal?.aborted) {
        answer.append(" (dihentikan)");
        if (error?.partialText) history.add("assistant", error.partialText);
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

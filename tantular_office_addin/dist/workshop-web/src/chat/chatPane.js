import { routeIntent, defaultContextFor, prefersSelectionContext } from "./intentRouter.js";
import { createHistory } from "./history.js";
import { getPipeline } from "./pipelines/index.js";
import {
  appendStructuredTextToWord,
  getDocumentBodyText,
  getSelectionContext,
  insertStructuredTextAfterSelection,
  insertStructuredTextIntoWord
} from "../officeClient.js";
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

  function officeErrorMessage(error) {
    // Log the full error so Wef/browser devtools keep every detail.
    console.error("[TantularChat]", error, error?.debugInfo);
    const message = String(error?.message ?? error ?? "Terjadi kesalahan.");
    const code = String(error?.code || "").trim();
    const debug = error?.debugInfo || {};
    const location = String(debug.errorLocation || "").trim();
    const statement = String(debug.statement || "").trim();
    const trace = Array.isArray(debug.traceMessages) && debug.traceMessages.length
      ? String(debug.traceMessages[0])
      : "";
    return [
      message,
      code && !message.includes(code) ? `Kode: ${code}` : "",
      location ? `Lokasi: ${location}` : "",
      statement ? `Perintah: ${statement}` : "",
      trace ? `Jejak: ${trace}` : ""
    ].filter(Boolean).join(" · ");
  }

  function appendInlineMarkdown(parent, text) {
    const parts = String(text || "").split(/(\*\*.*?\*\*|`.*?`)/g).filter(Boolean);
    for (const part of parts) {
      if (part.startsWith("**") && part.endsWith("**")) {
        const strong = document.createElement("strong");
        strong.textContent = part.slice(2, -2);
        parent.appendChild(strong);
      } else if (part.startsWith("`") && part.endsWith("`")) {
        const code = document.createElement("code");
        code.textContent = part.slice(1, -1);
        parent.appendChild(code);
      } else {
        parent.appendChild(document.createTextNode(part));
      }
    }
  }

  function renderChatTable(container, tableLines) {
    const parseRow = (line) => line.slice(1, -1).split("|").map((cell) => cell.trim());
    const isSeparator = (cells) => cells.every((cell) => /^:?-{2,}:?$/.test(cell));
    const hasHeader = tableLines.length >= 2 && isSeparator(parseRow(tableLines[1]));
    const table = document.createElement("table");
    table.className = "chat-table";
    tableLines.forEach((line, index) => {
      const cells = parseRow(line);
      if (isSeparator(cells)) return;
      const tr = document.createElement("tr");
      for (const text of cells) {
        const cell = document.createElement(hasHeader && index === 0 ? "th" : "td");
        appendInlineMarkdown(cell, text);
        tr.appendChild(cell);
      }
      table.appendChild(tr);
    });
    container.appendChild(table);
  }

  function renderChatMarkdown(container, markdown) {
    let activeList = null;
    const flushList = () => { activeList = null; };
    const lines = String(markdown || "").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (/^\|.*\|$/.test(line)) {
        flushList();
        const tableLines = [];
        while (index < lines.length && /^\|.*\|$/.test(lines[index].trim())) {
          tableLines.push(lines[index].trim());
          index += 1;
        }
        index -= 1;
        renderChatTable(container, tableLines);
        continue;
      }
      if (!line) { flushList(); continue; }
      if (/^---+$/.test(line)) {
        container.appendChild(document.createElement("hr"));
        flushList();
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        const h = document.createElement(heading[1].length <= 2 ? "h3" : "h4");
        appendInlineMarkdown(h, heading[2]);
        container.appendChild(h);
        flushList();
        continue;
      }
      const bullet = line.match(/^[-•]\s+(.+)$/);
      if (bullet) {
        if (!activeList || activeList.tagName !== "UL") {
          activeList = document.createElement("ul");
          container.appendChild(activeList);
        }
        const li = document.createElement("li");
        appendInlineMarkdown(li, bullet[1]);
        activeList.appendChild(li);
        continue;
      }
      const numbered = line.match(/^\d+[.)]\s+(.+)$/);
      if (numbered) {
        if (!activeList || activeList.tagName !== "OL") {
          activeList = document.createElement("ol");
          container.appendChild(activeList);
        }
        const li = document.createElement("li");
        appendInlineMarkdown(li, numbered[1]);
        activeList.appendChild(li);
        continue;
      }
      const paragraph = document.createElement("p");
      appendInlineMarkdown(paragraph, line);
      container.appendChild(paragraph);
      flushList();
    }
  }

  function addDocumentAnswerActions(answer, result) {
    const actions = document.createElement("div");
    actions.className = "chat-answer-actions";
    const prompt = document.createElement("small");
    prompt.textContent = "Gunakan jawaban ini di dokumen?";
    actions.appendChild(prompt);

    if (result.insertionAnchor) {
      const targeted = document.createElement("button");
      targeted.type = "button";
      targeted.className = "chat-chip";
      targeted.textContent = "Tambahkan setelah sub-section ini";
      targeted.addEventListener("click", async () => {
        targeted.disabled = true;
        try {
          const message = await insertStructuredTextIntoWord(result.text, {
            afterText: result.insertionAnchor,
            fallbackToEnd: false
          });
          addBubble("assistant", message);
        } catch (error) {
          addBubble("error", officeErrorMessage(error));
          targeted.disabled = false;
        }
      });
      actions.appendChild(targeted);
    }

    if (result.suggestedEdit) {
      const update = document.createElement("button");
      update.type = "button";
      update.className = "chat-chip";
      update.textContent = "Perbarui sub-section ini";
      update.addEventListener("click", async () => {
        update.disabled = true;
        try {
          const [{ resolveEdits }, { renderEditPreview }] = await Promise.all([
            import("./editContract.js"),
            import("./wordEdits.js")
          ]);
          const body = await getDocumentBodyText();
          const edits = resolveEdits(body, [result.suggestedEdit]);
          renderEditPreview({ container: els.messages, edits, addBubble });
        } catch (error) {
          addBubble("error", officeErrorMessage(error));
          update.disabled = false;
        }
      });
      actions.appendChild(update);
    }

    // Precise placement: the user clicks/selects the destination in the
    // document, then applies. No anchor guessing involved.
    const atSelection = document.createElement("button");
    atSelection.type = "button";
    atSelection.className = "chat-chip";
    atSelection.textContent = "Sisipkan setelah teks yang saya pilih";
    atSelection.title = "Klik atau blok paragraf tujuan di dokumen dulu, lalu tekan tombol ini.";
    atSelection.addEventListener("click", async () => {
      atSelection.disabled = true;
      try {
        const message = await insertStructuredTextAfterSelection(result.text);
        addBubble("assistant", message);
      } catch (error) {
        addBubble("error", officeErrorMessage(error));
        atSelection.disabled = false;
      }
    });
    actions.appendChild(atSelection);

    const append = document.createElement("button");
    append.type = "button";
    append.className = "chat-chip";
    append.textContent = "Tambahkan ke akhir dokumen";
    append.addEventListener("click", async () => {
      append.disabled = true;
      try {
        const message = await appendStructuredTextToWord(result.text);
        addBubble("assistant", message);
      } catch (error) {
        addBubble("error", officeErrorMessage(error));
        append.disabled = false;
      }
    });
    actions.appendChild(append);
    answer.appendChild(actions);
  }

  async function gatherContext(mode, signal, query = "") {
    if (mode === "none") return { text: "", label: "none" };
    if (mode === "selection") {
      const selection = await getSelectionContext("Word");
      return { text: selection.text ?? "", label: "selection" };
    }
    // "document" — Stage 1A has no doc reader yet; Task 7 swaps this in.
    const { buildDocumentContext } = await import("./contextBuilder.js").catch(() => ({}));
    if (!buildDocumentContext) return { text: "", label: "none" };
    return {
      text: await buildDocumentContext({
        emitProgress: (msg) => setBusyNote(msg),
        signal,
        query
      }),
      label: "document"
    };
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
      if (!hasSelection && prefersSelectionContext(message)) {
        answer.textContent = "Tidak ada teks yang sedang dipilih di dokumen. Blok dulu paragraf yang dimaksud di Word, biarkan tetap terseleksi, lalu kirim ulang pertanyaannya.";
        return;
      }
      let mode = state.contextOverride ?? defaultContextFor(intent, hasSelection);
      // "…yang saya pilih…" refers to the live selection; honor it even when
      // the default (or pinned) context is the whole document.
      if (hasSelection && prefersSelectionContext(message)) mode = "selection";
      setPill(mode);
      const context = mode === "selection"
        ? { text: selection.text ?? "" }
        : await gatherContext(mode, state.abort.signal, message);
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
      if (result.kind === "text" && result.text) {
        // Replace streamed plain text with a safe formatted rendering once the
        // complete response is available.
        answer.replaceChildren(tag);
        renderChatMarkdown(answer, result.text);
        if (intent === "TANYA_DOKUMEN") addDocumentAnswerActions(answer, result);
      }
      if (result.kind === "edits") {
        answer.replaceChildren(tag, document.createTextNode("Usulan edit siap. Buka detail edit di bawah untuk meninjau perubahan."));
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
            // HTML-aware insert: tables/headings/lists become real Word
            // structures instead of raw markdown pasted at the cursor.
            const message = await insertStructuredTextAfterSelection(result.text);
            addBubble("assistant", message);
          } catch (error) {
            addBubble("error", officeErrorMessage(error));
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
        addBubble("error", officeErrorMessage(error));
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

import { routeIntent, defaultContextFor, prefersSelectionContext } from "./intentRouter.js";
import { createHistory } from "./history.js";
import { prepareTurn } from "./turn.js";
import { contextIsCurrent, STALE_ANSWER_MESSAGE } from "./staleGuard.js";
import { deriveReferent, parseChoice } from "./followUp.js";
import { isShortenRequest, runPersingkat } from "./pipelines/persingkat.js";
import { getPipeline } from "./pipelines/index.js";
import {
  appendStructuredTextToWord,
  getDocumentBodyText,
  getSelectionContext,
  insertStructuredTextAfterSelection,
  insertStructuredTextIntoWord
} from "../officeClient.js";
import { actionsForHost } from "../prompts.js";
import { consumeAutoSwitchNote } from "../tantularClient.js";

const CONTEXT_LABELS = { selection: "Seleksi", document: "Dokumen (isi utama)", none: "Tanpa konteks" };
const CONTEXT_ORDER = [null, "selection", "document", "none"];

export function mountChatPane({ host }) {
  const card = document.querySelector("#chat-card");
  if (!card) return;
  // RETURN these promises. The caller in taskpane.js attaches the .catch that
  // turns a mount failure into a visible message; a promise created here and
  // dropped on the floor rejects where nothing is listening, so a broken
  // Excel/PowerPoint chat looked exactly like a host that has no chat — an
  // empty gap between the mode banner and the settings card, no error anywhere.
  if (host === "Excel") {
    // Agentic Excel chat: same card, different engine (plan-and-execute over
    // the open workbook instead of Word document pipelines).
    return import("./excelChat.js").then(({ mountExcelChatPane }) => mountExcelChatPane());
  }
  if (host === "PowerPoint") {
    // Agentic deck chat: plan-and-execute over the active presentation instead
    // of the Word document pipelines.
    return import("./pptChat.js").then(({ mountPptChatPane }) => mountPptChatPane());
  }
  if (host !== "Word") return;
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
  const state = { contextOverride: null, abort: null, busy: false, referent: null };

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
          const { bodyRevision } = await import("./contextBuilder.js");
          renderEditPreview({
            container: els.messages,
            edits,
            addBubble,
            expectedRevision: bodyRevision(body),
            readBody: getDocumentBodyText,
            onApplied: rememberApplied
          });
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

  // After an approved edit, remember what it produced (only spans that are
  // unique in the document as it now stands) so "buat lebih singkat" can be
  // resolved against a verified target. See followUp.js.
  async function rememberApplied(appliedEdits) {
    try {
      state.referent = deriveReferent(appliedEdits, await getDocumentBodyText());
    } catch {
      state.referent = null;
    }
  }

  async function gatherContext(mode, signal, query = "") {
    if (mode === "none") return { text: "", label: "none", kind: "none", scope: "none" };
    if (mode === "selection") {
      const selection = await getSelectionContext("Word");
      const text = selection.text ?? "";
      return { text, label: "selection", kind: "selection", scope: `selection:${text}` };
    }
    // "document" — Stage 1A has no doc reader yet; Task 7 swaps this in.
    const { buildDocumentContextSnapshot } = await import("./contextBuilder.js").catch(() => ({}));
    if (!buildDocumentContextSnapshot) return { text: "", label: "none", kind: "none", scope: "none" };
    const snapshot = await buildDocumentContextSnapshot({
      emitProgress: (msg) => setBusyNote(msg),
      signal,
      query
    });
    return {
      text: snapshot.text,
      label: "document",
      kind: "document",
      revision: snapshot.revision,
      scope: `document:${snapshot.revision}`
    };
  }

  let busyNote = null;
  function setBusyNote(text) {
    if (!busyNote) busyNote = addBubble("assistant", "");
    busyNote.textContent = text;
  }

  async function send() {
    const typed = els.input.value.trim();
    if (!typed || state.busy) return;
    state.busy = true;
    els.input.value = "";
    els.send.classList.add("hidden");
    els.stop.classList.remove("hidden");
    addBubble("user", typed);
    const answer = addBubble("assistant", "");
    state.abort = new AbortController();
    try {
      // A short reply ("yang kedua") to a pending "which one?" answers it: run
      // the ORIGINAL request, with its original intent, on the chosen span.
      const pending = state.referent?.awaiting ? state.referent : null;
      const choice = pending ? parseChoice(typed, pending.texts.length) : null;
      const message = choice !== null ? pending.originalMessage : typed;
      const intent = choice !== null
        ? pending.intent
        : await routeIntent(message, { signal: state.abort.signal });
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
      const turn = await prepareTurn({
        message,
        mode,
        selectionText: selection.text ?? "",
        history,
        referent: state.referent,
        choice,
        readBody: getDocumentBodyText,
        gather: (m) => gatherContext(m, state.abort.signal, message)
      });
      if (turn.kind === "ask") {
        // Never guess a referent after the document changed: ask instead.
        answer.textContent = turn.message;
        if (turn.pending) {
          state.referent = { texts: turn.pending.texts, awaiting: true, originalMessage: turn.pending.originalMessage, intent };
        }
        return;
      }
      const { context, priorMessages } = turn;
      state.referent = null; // one-shot: a referent is never reused later
      const tag = document.createElement("span");
      tag.className = "intent-tag";
      tag.textContent = `${intent} · ${CONTEXT_LABELS[mode]}`;
      answer.prepend(tag);
      let emitted = 0;
      // A comparative "lebih singkat" on a bounded span is a rewrite, never RINGKAS
      // (whose prompt forces 3-7 bullets).
      const boundedSpan = turn.usedReferent || context.kind === "selection";
      const pipeline = boundedSpan && isShortenRequest(message) ? runPersingkat : getPipeline(intent);
      const result = await pipeline({
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
      // The document or selection may have changed while the model ran. A
      // stale answer must not be shown, offered for insertion, or remembered.
      const stillCurrent = await contextIsCurrent(context, {
        readBody: getDocumentBodyText,
        readSelection: async () => (await getSelectionContext("Word")).text ?? ""
      });
      if (!stillCurrent) {
        answer.replaceChildren(document.createTextNode(STALE_ANSWER_MESSAGE));
        history.clear();
        return;
      }
      // Chat/edit tasks can silently auto-switch model mid-request (see
      // runTantular's auto-downgrade in tantularClient.js) — e.g. the
      // configured model was never installed on this machine. Studio surfaces
      // this via state.deckAutoSwitchNote; chat had no equivalent, so the
      // switch happened invisibly and Pengaturan model lokal looked like it
      // had silently changed itself.
      const autoSwitchNote = consumeAutoSwitchNote();
      if (autoSwitchNote) addBubble("assistant", autoSwitchNote);
      if (result.kind === "text" && result.text) {
        // Replace streamed plain text with a safe formatted rendering once the
        // complete response is available.
        answer.replaceChildren(tag);
        renderChatMarkdown(answer, result.text);
        // RINGKAS results had no way to reach the document at all — the user
        // could read a summary in the chat pane but never insert it, unlike
        // TANYA_DOKUMEN (full action set) or DRAFT_TEKS (single insert
        // button). Every insert here still requires the user's own click —
        // consistent with this pane's existing confirm-gated writes, never
        // automatic.
        if (intent === "TANYA_DOKUMEN" || intent === "RINGKAS") addDocumentAnswerActions(answer, result);
      }
      if (result.kind === "edits") {
        const skippedNote = result.skipped?.length
          ? ` (${result.skipped.length} usulan edit dilewati karena tidak valid — sisanya tetap ditampilkan.)`
          : "";
        answer.replaceChildren(tag, document.createTextNode(
          `Usulan edit siap. Buka detail edit di bawah untuk meninjau perubahan.${skippedNote}`
        ));
        let renderEditPreview;
        try {
          ({ renderEditPreview } = await import("./wordEdits.js"));
        } catch {
          addBubble("error", "Fitur edit belum tersedia di build ini.");
          return;
        }
        renderEditPreview({
          container: els.messages,
          edits: result.edits,
          addBubble,
          expectedRevision: result.revision,
          readBody: getDocumentBodyText,
          onApplied: rememberApplied
        });
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
      if (error?.code === "DOCUMENT_CHANGED") {
        // Readable, in place of the empty assistant bubble.
        answer.replaceChildren(document.createTextNode(String(error.message)));
        history.clear();
      } else if (String(error?.message) === "dihentikan" || state.abort?.signal?.aborted) {
        answer.append(" (dihentikan)");
        if (error?.partialText) history.add("assistant", error.partialText);
      } else {
        addBubble("error", officeErrorMessage(error));
      }
    } finally {
      // The progress note is transient; leaving it beside the final answer or
      // error read as a stuck "bagian 5/5".
      busyNote?.remove();
      busyNote = null;
      state.busy = false;
      state.abort = null;
      els.send.classList.remove("hidden");
      els.stop.classList.add("hidden");
    }
  }
}

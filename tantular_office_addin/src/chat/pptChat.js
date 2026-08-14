// Agentic PowerPoint chat: freestyle instructions over the active deck.
// One model call plans JSON actions (improve/replace/add/delete slide) grounded
// in a deck snapshot; pptTools sanitizes and orders them into a PLAN. Nothing is
// written to the deck until the user reads that plan and confirms it — a live
// "Ringkas isi deck ini" (a question) once had seven slides rewritten under it.
// This file must never touch an Office/PowerPoint API directly.

import { runTantular } from "../tantularClient.js";
import { extractJsonObject } from "../deck/deckPlanner.js";
import { createHistory } from "./history.js";
import {
  deckContextToPromptText,
  executeConfirmedPptPlan,
  executePptActions,
  getDeckContext,
  needsPptConfirmation,
  sanitizePptActions,
  summarizePendingChanges
} from "./pptTools.js";

const PPT_CHAT_SYSTEM = `Anda adalah Tantular, asisten PowerPoint agentic berbahasa Indonesia.
Anda menerima snapshot deck aktif (daftar slide beserta teksnya) dan permintaan pengguna, lalu membalas SATU objek JSON valid:
{
  "reply": "jawaban singkat dan jelas untuk pengguna (Bahasa Indonesia)",
  "actions": []
}

Aksi yang tersedia di "actions" (kosongkan jika pengguna hanya bertanya):
- {"op":"improve_slide","slideIndex":4}  → perbaiki slide yang sudah ada; JANGAN sertakan konten, Tantular yang menyusunnya dari teks slide asli.
  SELALU sertakan "instruction" (maksimal 200 karakter) berisi maksud pengguna untuk slide itu — hanya niat, bukan konten slide.
  Jika pengguna menulis "perbaiki slide 4 supaya lebih ringkas", maka instruction-nya "supaya lebih ringkas".
  Contoh: {"op":"improve_slide","slideIndex":4,"instruction":"buat lebih ringkas"}
  Jika pengguna tidak menyebut maksud khusus, tulis instruction singkat yang menggambarkan permintaannya, misalnya "rapikan dan perjelas".
- {"op":"replace_slide","slideIndex":3,"slide":{...}}  → ganti slide dengan konten yang Anda tulis sendiri.
- {"op":"add_slide","afterIndex":5,"slide":{...}}  → sisipkan slide baru setelah slide 5.
- {"op":"delete_slide","slideIndex":7}  → usulkan penghapusan.
Semua aksi di atas hanya USULAN: pengguna harus mengonfirmasi sebelum deck benar-benar berubah.

Bentuk objek "slide" (pilih type sesuai isi):
- {"type":"title","headline":"...","subhead":"..."}
- {"type":"bullets"|"agenda","headline":"...","bullets":["..."]}
- {"type":"cards","headline":"...","cards":[{"title":"...","desc":"..."}]}
- {"type":"columns","headline":"...","columns":[{"title":"...","points":["..."]}]}
- {"type":"metrics","headline":"...","metrics":[{"value":"92%","label":"..."}]}
- {"type":"visualization","headline":"...","chartType":"bar|line|heatmap","data":[{"label":"...","value":0}]}
- {"type":"quote","quote":"...","subhead":"atribusi"}
- {"type":"closing","headline":"..."}

Aturan WAJIB:
- Dasarkan semua slideIndex pada nomor slide di snapshot. Jangan mengarang nomor slide.
- Untuk memperbaiki slide yang sudah ada, PAKAI improve_slide. Jangan menulis ulang isinya sendiri lewat replace_slide.
- JUJUR terhadap snapshot: jangan mengklaim sesuatu sudah beres kecuali teks slide di snapshot membuktikannya.
- Snapshot bisa terpotong. Jangan menyimpulkan sebuah slide kosong hanya karena teksnya tidak terlihat penuh.
- Jangan mengarang angka, nama, atau fakta yang tidak ada di deck.
- Setiap slide harus punya "headline" (kecuali quote, yang boleh hanya "quote"), dan type berkonten harus punya arraynya (bullets/cards/columns/metrics/data) yang tidak kosong.
- Slide type "columns" minimal 2 kolom, dan setiap kolom wajib punya "title" asli (bukan "Kolom 1"). Kalau hanya ada satu kelompok poin, pakai type "bullets".
- Menyisipkan di posisi paling depan belum didukung; afterIndex minimal 1.
- Maksimum 8 aksi per giliran. Jika permintaan lebih besar, kerjakan yang terpenting dan jelaskan sisanya di "reply".
- Jika permintaan tidak bisa dipenuhi dengan aksi yang tersedia, actions kosong dan jelaskan alasannya di "reply".
- Balas HANYA JSON. Tanpa markdown, tanpa teks lain.`;

export function mountPptChatPane() {
  const card = document.querySelector("#chat-card");
  if (!card) return;
  card.classList.remove("hidden");

  const els = {
    messages: card.querySelector("#chat-messages"),
    input: card.querySelector("#chat-input"),
    send: card.querySelector("#chat-send"),
    stop: card.querySelector("#chat-stop"),
    pill: card.querySelector("#chat-context-pill"),
    chips: card.querySelector("#chat-chips")
  };
  const history = createHistory({ maxChars: 4000 });
  const state = { abort: null, busy: false };

  els.pill.textContent = "Konteks: deck aktif";
  els.pill.title = "Klik untuk membaca ulang deck aktif";
  els.pill.addEventListener("click", () => reloadDeck());
  renderChips();

  els.send.addEventListener("click", () => send());
  els.stop.addEventListener("click", () => state.abort?.abort());
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  // Deck Studio owns tone/style/project instructions; the chat reuses them so
  // slides it writes match the ones Deck Studio generates.
  function deckSettings() {
    return {
      tone: document.querySelector("#deck-tone")?.value.trim() || "",
      instruction: document.querySelector("#deck-project-instructions")?.value.trim() || "",
      styleId: document.querySelector("#deck-style")?.value || "nusantara"
    };
  }

  function renderChips() {
    // Chips are READ-ONLY on purpose. They are one click away for someone who
    // has not yet worked out what this pane does, and a deck has no undo here —
    // so nothing that mutates slides belongs in them. Writing stays available by
    // typing, which takes a deliberate sentence.
    // They also must not hardcode a slide number: it is arbitrary against the
    // user's real deck, and "slide 2" reads as "two slides" in Indonesian —
    // ambiguity handed straight to a weak local model as its instruction.
    // Phrase every chip as a QUESTION, never an imperative. "Ringkas isi deck
    // ini" reads in Indonesian as "condense this deck" — an instruction to edit
    // — and a model holding slide-editing tools acted on it: one click once
    // rewrote seven slides. Whether it answers or edits is otherwise a coin
    // flip. A question has no such second reading.
    const prompts = [
      "Apa isi deck ini?",
      "Apa pesan utama deck ini?",
      "Apa yang kurang dari deck ini?"
    ];
    for (const prompt of prompts) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chat-chip";
      chip.textContent = prompt;
      chip.addEventListener("click", () => {
        els.input.value = prompt;
        els.input.focus();
      });
      els.chips.appendChild(chip);
    }
  }

  function addBubble(cls, text = "") {
    const div = document.createElement("div");
    div.className = `chat-bubble ${cls}`;
    div.textContent = text;
    els.messages.appendChild(div);
    els.messages.scrollTop = els.messages.scrollHeight;
    return div;
  }

  // ONE confirmation per turn, covering every planned change — improve, replace,
  // add and delete alike. `turnSignal` is the planning turn's abort signal: a
  // confirmation may never fire a write for a turn the user already stopped.
  function addPlanConfirm(pending, bubble, turnSignal, writeHooks) {
    const summary = summarizePendingChanges(pending);
    bubble.textContent = [
      bubble.textContent,
      "",
      summary.headline,
      ...summary.lines.map((line) => `• ${line}`)
    ].join("\n").trim();
    const base = bubble.textContent;

    const row = document.createElement("div");
    row.className = "chat-actions";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "primary";
    confirm.textContent = summary.confirmLabel;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = summary.cancelLabel;

    confirm.addEventListener("click", async () => {
      // An unconfirmed plan from an earlier turn can still be on screen while a
      // new turn is running. Writing now would race that turn, so we do not —
      // but returning silently left the user looking at an unchanged row with no
      // message, which reads exactly like "applied". Say so, and leave the
      // buttons live so the click can simply be repeated.
      if (state.busy) {
        bubble.textContent = `${base}\n⏳ Tunggu sampai proses yang sedang berjalan selesai, lalu klik lagi.`;
        els.messages.scrollTop = els.messages.scrollHeight;
        return;
      }
      confirm.disabled = true;
      cancel.disabled = true;
      row.remove();
      // Stop was pressed while this turn was still planning. The plan on screen
      // belongs to that aborted turn, so it must never be written.
      if (turnSignal?.aborted) {
        bubble.textContent = `${base}\n⏹ Giliran ini dihentikan; tidak ada yang ditulis ke deck.`;
        return;
      }

      // The confirmed writes call the model again (improve_slide), so Stop has
      // to work here too — on a fresh controller for the write phase.
      state.busy = true;
      state.abort = new AbortController();
      els.stop.classList.remove("hidden");
      const signal = state.abort.signal;
      let lines;
      try {
        const result = await executeConfirmedPptPlan(pending, {
          ...writeHooks,
          signal,
          onProgress: (text) => { bubble.textContent = `${base}\n${text}`; }
        });
        lines = result.lines;
      } catch (error) {
        // executeConfirmedPptPlan throws outright when the PowerPoint API is
        // missing. Unhandled, the bubble would freeze mid-progress and the user
        // could not tell whether their deck was touched. Report it like
        // everything else.
        console.error("[TantularChat/PPT] konfirmasi gagal", error);
        lines = [`❌ Perubahan gagal dijalankan: ${error?.message || error}`];
      } finally {
        state.busy = false;
        state.abort = null;
        els.stop.classList.add("hidden");
      }
      bubble.textContent = [base, "", ...lines].join("\n").trim();
      els.messages.scrollTop = els.messages.scrollHeight;
    });
    cancel.addEventListener("click", () => {
      row.remove();
      bubble.textContent = `${base}\n${summary.cancelledLine}`;
    });

    row.appendChild(confirm);
    row.appendChild(cancel);
    els.messages.appendChild(row);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  async function reloadDeck() {
    if (state.busy) return;
    const bubble = addBubble("assistant", "Membaca ulang deck aktif...");
    try {
      const ctx = await getDeckContext({ force: true });
      bubble.textContent = `Deck dimuat ulang: ${ctx.meta}`;
    } catch (error) {
      bubble.textContent = String(error?.message || error);
      bubble.classList.add("error");
    }
  }

  async function send() {
    const message = els.input.value.trim();
    if (!message || state.busy) return;
    els.input.value = "";
    addBubble("user", message);
    const answer = addBubble("assistant", "Membaca deck aktif...");
    state.busy = true;
    state.abort = new AbortController();
    els.stop.classList.remove("hidden");

    try {
      const ctx = await getDeckContext();
      els.pill.textContent = `Konteks: deck aktif (${ctx.source})`;
      answer.textContent = "Menyusun rencana...";

      const { tone, instruction, styleId } = deckSettings();
      const raw = await runTantular({
        system: PPT_CHAT_SYSTEM,
        user: `Snapshot deck:\n"""${deckContextToPromptText(ctx)}"""\n\n`
          + `Tone deck: ${tone || "profesional, jelas, executive"}\n`
          + `Style guide / instruksi project:\n"""${instruction || "tidak ada"}"""\n\n`
          + `Riwayat singkat:\n${history.toMessages().map((m) => `${m.role}: ${m.content}`).join("\n") || "-"}\n\n`
          + `Permintaan pengguna:\n"""${message}"""`,
        maxTokens: 3000,
        temperature: 0.15,
        task: "deck",
        jsonMode: true,
        signal: state.abort.signal
      });

      const parsed = extractJsonObject(raw);
      if (!parsed || typeof parsed.reply !== "string") {
        throw new Error("Model tidak mengembalikan rencana JSON yang valid. Coba ulangi atau perjelas permintaannya.");
      }

      // Bound on the snapshot itself, not its length: slide.index is a true deck
      // position and the extractor skips unreadable slides, so the two differ.
      const { actions, rejected } = sanitizePptActions(parsed.actions, ctx);
      answer.textContent = parsed.reply;

      // Planning only — this call cannot touch the deck.
      const { lines, pending } = executePptActions(actions, ctx);
      answer.textContent = [parsed.reply, "", ...lines, ...rejected.map((r) => `⚠️ ${r}`)]
        .join("\n").trim();

      // A genuine question plans nothing, so it never sees a confirmation.
      if (needsPptConfirmation(pending)) {
        addPlanConfirm(pending, answer, state.abort.signal, {
          tone,
          instruction,
          styleId,
          // The planner usually omits the optional per-action "instruction", so
          // the raw request travels here too and pptTools uses it as the fallback
          // intent for improve_slide. Without it the user's "supaya lebih ringkas"
          // never reaches the improve prompt at all.
          userRequest: message
        });
      }

      history.add("user", message);
      history.add("assistant", parsed.reply);
    } catch (error) {
      console.error("[TantularChat/PPT]", error, error?.debugInfo);
      // tantularClient turns any AbortError into a "model terlalu lama" timeout
      // message. Telling a user who just pressed Stop that their model is slow
      // is wrong — same guard chatPane.js uses for Word.
      if (state.abort?.signal?.aborted || String(error?.message) === "dihentikan") {
        answer.textContent = "⏹ Dihentikan oleh pengguna.";
      } else {
        answer.textContent = String(error?.message || error || "Terjadi kesalahan.");
        answer.classList.add("error");
      }
    } finally {
      state.busy = false;
      state.abort = null;
      els.stop.classList.add("hidden");
    }
  }
}

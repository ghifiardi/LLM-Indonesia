// Agentic PowerPoint chat: freestyle instructions over the active deck.
// One model call plans JSON actions (improve/replace/add/delete slide) grounded
// in a deck snapshot; pptTools sanitizes and orders them into a PLAN. Nothing is
// written to the deck until the user reads that plan and confirms it — a live
// "Ringkas isi deck ini" (a question) once had seven slides rewritten under it.
// This file must never touch an Office/PowerPoint API directly.

import { runTantular } from "../tantularClient.js";
import { extractJsonObject } from "../deck/deckPlanner.js";
import { describeSlideStructure, getSelectedSlideTextContext, readSlideShapeTexts } from "../officeClient.js";
import { describeSuggestion, requestSuggestions, wantsSuggestions } from "./pptSuggest.js";
import { parseFormatRequest } from "./pptFormat.js";
import { createHistory } from "./history.js";
import {
  SELECT_ONE_SLIDE_MESSAGE,
  DECK_SETTINGS_NOTE,
  mentionsSelectedSlide,
  groundActionIntent,
  pinActionsToSlide,
  pptQuickChips,
  resolveSelectedSlideIndex,
  rewriteSelectedSlideMessage,
  wantsLayoutTidy
} from "./pptSelectedSlide.js";
import {
  deckContextToPromptText,
  executeConfirmedPptPlan,
  executePptActions,
  executeSuggestionPlan,
  executeRelayout,
  executeFormat,
  extractRequestedSlideIndex,
  resolveActionTarget,
  getDeckContext,
  needsPptConfirmation,
  preferImproveOverReplace,
  resolveImproveIntent,
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
  instruction WAJIB diambil dari kata-kata pengguna sendiri. Jika pengguna hanya menulis "perbaiki slide 4" tanpa maksud khusus, KOSONGKAN instruction — jangan mengarang maksud (misalnya jangan menambahkan "lebih ringkas" kalau pengguna tidak memintanya).
  Contoh: {"op":"improve_slide","slideIndex":4,"instruction":"<maksud pengguna, atau kosong>"}
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

  import("./voiceControls.js")
    .then(({ mountVoiceControls }) => mountVoiceControls({ card, send, isBusy: () => state.busy, addBubble }))
    .catch((error) => console.warn("[TantularVoice] not available:", error));

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
    // Two kinds of chip, both defined as data in pptSelectedSlide.js:
    //  - The question chips are READ-ONLY on purpose: they fill the box and
    //    the user still has to press send. A deck has no undo here, so
    //    nothing that mutates slides belongs one click away — and they are
    //    phrased as QUESTIONS, never imperatives: "Ringkas isi deck ini" once
    //    rewrote seven slides under a model holding slide-editing tools.
    //  - The two improve chips DO send. Sending only produces a PLAN: the
    //    confirmation row below is still the only thing that writes, and the
    //    request names "slide terpilih", so with no single selected slide the
    //    turn ends in a message and zero actions.
    for (const item of pptQuickChips("PowerPoint")) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chat-chip";
      chip.textContent = item.label;
      chip.addEventListener("click", () => {
        els.input.value = item.message;
        if (item.submit) send();
        else els.input.focus();
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

  // "Usulkan perbaikan slide ini": a checklist of concrete, grounded changes.
  // Nothing is written until the user ticks items and clicks apply; the apply
  // runs executeSuggestionPlan, which re-reads the live slide and writes only
  // the ticked items into the slide's own shapes.
  function addSuggestionChecklist(list, bubble, target, turnSignal) {
    bubble.textContent = `Usulan perbaikan untuk slide ${target.slideIndex} (desain slide dipertahankan). `
      + "Centang yang ingin diterapkan, lalu klik Terapkan:";
    const base = bubble.textContent;

    const form = document.createElement("div");
    form.className = "chat-checklist";
    const boxes = [];
    for (const s of list) {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = s.id;
      const text = document.createElement("span");
      text.textContent = describeSuggestion(s);
      label.appendChild(box);
      label.appendChild(text);
      form.appendChild(label);
      boxes.push(box);
    }

    const row = document.createElement("div");
    row.className = "chat-actions";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "primary";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Batal";
    const selected = () => boxes.filter((b) => b.checked).map((b) => b.value);
    const refresh = () => {
      const n = selected().length;
      apply.textContent = `Terapkan ${n} perubahan`;
      apply.disabled = n === 0;
    };
    boxes.forEach((b) => b.addEventListener("change", refresh));
    refresh();

    apply.addEventListener("click", async () => {
      if (state.busy) {
        bubble.textContent = `${base}\n⏳ Tunggu sampai proses yang sedang berjalan selesai, lalu klik lagi.`;
        return;
      }
      const ids = selected();
      if (!ids.length) return;
      if (turnSignal?.aborted) {
        bubble.textContent = `${base}\n⏹ Giliran ini dihentikan; tidak ada yang ditulis ke deck.`;
        return;
      }
      apply.disabled = true;
      cancel.disabled = true;
      boxes.forEach((b) => { b.disabled = true; });
      row.remove();
      state.busy = true;
      state.abort = new AbortController();
      els.stop.classList.remove("hidden");
      let lines;
      try {
        const result = await executeSuggestionPlan(
          { slideId: target.slideId, slideIndex: target.slideIndex, suggestions: list, selectedIds: ids },
          { signal: state.abort.signal, onProgress: (text) => { bubble.textContent = `${base}\n${text}`; } }
        );
        lines = result.lines;
      } catch (error) {
        console.error("[TantularChat/PPT] usulan gagal diterapkan", error);
        lines = [`❌ Perubahan gagal dijalankan: ${error?.message || error}`];
      } finally {
        state.busy = false;
        state.abort = null;
        els.stop.classList.add("hidden");
      }
      form.remove();
      bubble.textContent = [base, "", ...lines].join("\n").trim();
      els.messages.scrollTop = els.messages.scrollHeight;
    });
    cancel.addEventListener("click", () => {
      row.remove();
      form.remove();
      bubble.textContent = `${base}\n⏹ Dibatalkan. Tidak ada slide yang diubah.`;
    });

    row.appendChild(apply);
    row.appendChild(cancel);
    els.messages.appendChild(form);
    els.messages.appendChild(row);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  // One confirm row for the deterministic slide actions (re-layout, format):
  // the runner is called only from the click, with a fresh abort controller.
  function addActionConfirm(bubble, label, turnSignal, runner) {
    const base = bubble.textContent;
    const row = document.createElement("div");
    row.className = "chat-actions";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "primary";
    confirm.textContent = label;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "Batal";
    confirm.addEventListener("click", async () => {
      if (state.busy) { bubble.textContent = `${base}\n⏳ Tunggu sampai proses yang sedang berjalan selesai, lalu klik lagi.`; return; }
      if (turnSignal?.aborted) { bubble.textContent = `${base}\n⏹ Giliran ini dihentikan; tidak ada yang ditulis ke deck.`; return; }
      row.remove();
      state.busy = true;
      state.abort = new AbortController();
      els.stop.classList.remove("hidden");
      let lines;
      try {
        const result = await runner(state.abort.signal, (text) => { bubble.textContent = `${base}\n${text}`; });
        lines = result.lines;
      } catch (error) {
        console.error("[TantularChat/PPT] aksi slide gagal", error);
        lines = [`❌ Aksi gagal: ${error?.message || error}`];
      } finally {
        state.busy = false;
        state.abort = null;
        els.stop.classList.add("hidden");
      }
      bubble.textContent = [base, "", ...lines].join("\n").trim();
      els.messages.scrollTop = els.messages.scrollHeight;
    });
    cancel.addEventListener("click", () => { row.remove(); bubble.textContent = `${base}\n⏹ Dibatalkan. Tidak ada slide yang diubah.`; });
    row.appendChild(confirm);
    row.appendChild(cancel);
    els.messages.appendChild(row);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function addLayoutConfirm(target, bubble, turnSignal) {
    addActionConfirm(bubble, "Tata ulang slide", turnSignal,
      (signal, onProgress) => executeRelayout(target, { signal, onProgress }));
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

  // Which slide a deterministic action targets: an explicit number in the
  // message, else the slide the user pinned via "slide ini", else the LIVE
  // selection. "sesuaikan ukuran font" named none and was refused although a
  // slide was selected (live, 2026-09-05).
  async function resolveActionSlide(message, pinnedIndex, ctx) {
    let index = pinnedIndex || extractRequestedSlideIndex(message);
    if (!index) {
      const selected = await getSelectedSlideTextContext();
      const resolved = resolveSelectedSlideIndex(selected);
      if (resolved.ok) index = resolved.index;
    }
    const target = index ? resolveActionTarget(ctx, index) : null;
    return target?.id ? target : null;
  }

  async function send(spokenText = null, { voice = false } = {}) {
    const message = (spokenText ?? els.input.value).trim();
    if (!message || state.busy) return;
    if (!voice) els.input.value = "";
    addBubble(voice ? "user voice" : "user", message);
    const answer = addBubble("assistant", "Membaca deck aktif...");
    state.busy = true;
    state.abort = new AbortController();
    els.stop.classList.remove("hidden");

    let spoken = "";
    try {
      // "Perbaiki slide ini" names no slide number, and the planner can only
      // target numbers. Resolve the live selection FIRST: exactly one usable
      // slide becomes an explicit "slide N" for the planner; anything else ends
      // the turn here with a message and no actions — nothing is planned, so
      // nothing can be confirmed or written.
      let pinnedIndex = 0;
      let plannerMessage = message;
      if (mentionsSelectedSlide(message)) {
        answer.textContent = "Membaca slide terpilih...";
        const selected = await getSelectedSlideTextContext();
        const resolved = resolveSelectedSlideIndex(selected);
        if (!resolved.ok) {
          answer.textContent = resolved.reason;
          history.add("user", message);
          history.add("assistant", resolved.reason);
          return;
        }
        pinnedIndex = resolved.index;
        plannerMessage = rewriteSelectedSlideMessage(message, pinnedIndex);
      }

      const ctx = await getDeckContext();
      els.pill.textContent = `Konteks: deck aktif (${ctx.source})`;

      // A FORMATTING request: font size on the slide's own text boxes, or a
      // proportional fit via the re-layout. Code, not the model; confirm-gated.
      const format = parseFormatRequest(message);
      if (format) {
        const target = await resolveActionSlide(message, pinnedIndex, ctx);
        if (!target?.id) {
          answer.textContent = SELECT_ONE_SLIDE_MESSAGE;
          history.add("user", message);
          history.add("assistant", answer.textContent);
          return;
        }
        answer.textContent = format.kind === "fit"
          ? `Tantular akan menyesuaikan ukuran huruf slide ${target.index} agar proporsional dengan slide (menata ulang isi di desain yang sama). Tidak ada undo.`
          : `Tantular akan mengubah ukuran huruf isi slide ${target.index}${format.size ? ` menjadi ${format.size} pt` : format.delta > 0 ? " (lebih besar)" : " (lebih kecil)"}. Judul dan footer tidak disentuh. Tidak ada undo.`;
        addActionConfirm(answer, format.kind === "fit" ? "Sesuaikan ukuran" : "Ubah ukuran huruf", state.abort.signal,
          (signal, onProgress) => executeFormat({ slideId: target.id, slideIndex: target.index }, format, { signal, onProgress }));
        history.add("user", message);
        history.add("assistant", `format slide ${target.index}`);
        return;
      }

      // A LAYOUT repair: geometry only, deterministic, no model. Still a deck
      // mutation with no undo, so it waits for the same confirm row.
      if (wantsLayoutTidy(message)) {
        const target = await resolveActionSlide(message, pinnedIndex, ctx);
        if (!target?.id) {
          answer.textContent = SELECT_ONE_SLIDE_MESSAGE;
          history.add("user", message);
          history.add("assistant", answer.textContent);
          return;
        }
        answer.textContent = `Tantular akan menata ulang slide ${target.index} di dalam desainnya sendiri: isi dikelompokkan menjadi panel `
          + "dengan bar judul atau daftar yang dibagi rata, satu penanda per poin, huruf konsisten; warna dan font mengikuti slide. "
          + "Judul, footer, dan isi teks tidak berubah. Tidak ada undo.";
        addLayoutConfirm({ slideId: target.id, slideIndex: target.index }, answer, state.abort.signal);
        history.add("user", message);
        history.add("assistant", `rapikan tata letak slide ${target.index}`);
        return;
      }

      // A request for OPTIONS: analyse the slide, show a checklist, write
      // nothing. The planner is not involved.
      if (wantsSuggestions(message)) {
        const target = await resolveActionSlide(message, pinnedIndex, ctx);
        if (!target?.id) {
          answer.textContent = SELECT_ONE_SLIDE_MESSAGE;
          history.add("user", message);
          history.add("assistant", answer.textContent);
          return;
        }
        answer.textContent = `Membaca slide ${target.index}...`;
        const read = await readSlideShapeTexts({ slideId: target.id, slideIndex: target.index });
        const structure = read?.found ? describeSlideStructure(read.shapes) : null;
        if (!structure?.bodies) {
          answer.textContent = `Slide ${target.index} tidak punya teks yang bisa diusulkan perbaikannya.`;
          history.add("user", message);
          history.add("assistant", answer.textContent);
          return;
        }
        answer.textContent = `Menganalisis slide ${target.index}...`;
        const settings = deckSettings();
        const list = await requestSuggestions({
          structure, tone: settings.tone, instruction: settings.instruction, signal: state.abort.signal
        });
        if (!list.length) {
          answer.textContent = `Tidak ada usulan yang lolos pemeriksaan sumber untuk slide ${target.index}. Coba lagi, atau sebutkan bagian yang ingin diperbaiki.`;
        } else {
          addSuggestionChecklist(list, answer, { slideId: target.id, slideIndex: target.index }, state.abort.signal);
        }
        history.add("user", message);
        history.add("assistant", `${list.length} usulan untuk slide ${target.index}`);
        return;
      }

      answer.textContent = "Menyusun rencana...";

      const { tone, instruction, styleId } = deckSettings();
      const raw = await runTantular({
        system: PPT_CHAT_SYSTEM,
        user: `Snapshot deck:\n"""${deckContextToPromptText(ctx)}"""\n\n`
          + `Tone deck: ${tone || "profesional, jelas, executive"}\n`
          + `Style guide / instruksi project:\n"""${instruction || "tidak ada"}"""\n\n`
          + `Riwayat singkat:\n${history.toMessages().map((m) => `${m.role}: ${m.content}`).join("\n") || "-"}\n\n`
          + `Permintaan pengguna:\n"""${plannerMessage}"""`,
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
      const sanitized = sanitizePptActions(parsed.actions, ctx);
      let actions = sanitized.actions;
      const rejected = sanitized.rejected;
      // The user pointed at ONE slide. Whatever the planner emitted is pinned
      // back onto it, so a weak model cannot drift to slide 1.
      if (pinnedIndex) {
        const pinned = pinActionsToSlide(actions, pinnedIndex);
        actions = pinned.actions;
        rejected.push(...pinned.rejected);
      }
      // A replace aimed at a slide that has text is routed through improve,
      // so grounding, output language and the loss check apply to it.
      const routed = preferImproveOverReplace(actions, ctx, plannerMessage);
      actions = routed.actions;
      rejected.push(...routed.notes.map((note) => `ℹ️ ${note}`));

      // MEASURED: the local planner usually omits the per-action instruction.
      // The proposal line reads the intent to say whether the slide design is
      // kept or the layout will change, so attach the user's own request now,
      // with the same 200-char clamp the write path applies.
      // ...and a planner intent that the user's words do not back (the
      // prompt's own example leaking in) is replaced by the user's message.
      actions = actions.map((action) => (
        action.op === "improve_slide"
          ? { ...action, instruction: resolveImproveIntent("", groundActionIntent(action.instruction, plannerMessage)) }
          : action
      ));
      answer.textContent = parsed.reply;

      // Planning only — this call cannot touch the deck.
      const { lines, pending } = executePptActions(actions, ctx);
      const improves = pending.some((entry) => entry.op === "improve_slide");
      answer.textContent = [
        parsed.reply, "", ...lines, ...rejected.map((r) => `⚠️ ${r}`),
        ...(improves ? [`ℹ️ ${DECK_SETTINGS_NOTE}`] : [])
      ].join("\n").trim();

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
          userRequest: plannerMessage
        });
      }

      history.add("user", message);
      history.add("assistant", parsed.reply);
      spoken = answer.textContent;
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
    return { spoken: voice ? spoken : "" };
  }
}

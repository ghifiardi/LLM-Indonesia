// Agentic Excel chat: freestyle instructions over the open workbook.
// One model call plans JSON actions (write_cells / set_formula / add_sheet /
// add_chart) grounded in a workbook snapshot; guarded executors apply them and
// every result (or refusal) is reported in the chat — nothing silent.

import { runTantular } from "../tantularClient.js";
import { createHistory } from "./history.js";
import {
  contextToPromptText,
  executeExcelActions,
  getExcelChatContext,
  sanitizeExcelActions
} from "./excelTools.js";

const EXCEL_CHAT_SYSTEM = `Anda adalah Tantular, asisten Excel agentic berbahasa Indonesia.
Anda menerima snapshot workbook (sheet, data, seleksi) dan permintaan pengguna, lalu membalas SATU objek JSON valid:
{
  "reply": "jawaban singkat dan jelas untuk pengguna (Bahasa Indonesia)",
  "actions": []
}

Aksi yang tersedia di "actions" (kosongkan jika pengguna hanya bertanya):
- {"op":"write_cells","sheet":"opsional","address":"B2","values":[["baris1kol1","baris1kol2"]]}
- {"op":"set_formula","sheet":"opsional","address":"C2","formula":"=SUM(A1:A10)"}
- {"op":"add_sheet","name":"Nama Sheet","columns":["Kol1","Kol2"],"rows":[["a","b"]]}
- {"op":"add_chart","sheet":"opsional","type":"ColumnClustered|BarClustered|Line|Pie","dataAddress":"A1:C10","title":"Judul"}

Aturan WAJIB:
- Dasarkan semua alamat cell dan isi pada snapshot workbook. Jangan mengarang data yang tidak ada.
- Formula memakai nama fungsi Inggris dengan pemisah koma (API Excel), contoh =SUM(A1:A10), bukan titik koma.
- "sheet" kosong berarti sheet aktif. Jangan menghapus atau menimpa data tanpa diminta pengguna.
- Untuk chart, pilih dataAddress yang mencakup header + data numerik yang relevan (bukan seluruh sheet jika hanya sebagian relevan).
- Maksimum 400 cell tertulis per giliran; jika permintaan lebih besar, kerjakan bagian terpenting dan jelaskan di "reply".
- Jika permintaan tidak bisa dipenuhi dengan aksi yang tersedia, actions kosong dan jelaskan alasannya di "reply".
- Balas HANYA JSON. Tanpa markdown, tanpa teks lain.`;

export function mountExcelChatPane() {
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

  els.pill.textContent = "Konteks: workbook aktif";
  renderChips();

  els.send.addEventListener("click", () => send());
  els.stop.addEventListener("click", () => state.abort?.abort());
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  function renderChips() {
    const prompts = [
      "Buat chart dari data di sheet ini",
      "Tambahkan kolom Total dengan formula",
      "Jelaskan struktur sheet ini",
      "Buat sheet ringkasan dari data ini"
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

  async function send() {
    const message = els.input.value.trim();
    if (!message || state.busy) return;
    els.input.value = "";
    addBubble("user", message);
    const answer = addBubble("assistant", "Membaca workbook...");
    state.busy = true;
    state.abort = new AbortController();
    els.stop.classList.remove("hidden");

    try {
      const ctx = await getExcelChatContext();
      answer.textContent = "Menyusun rencana...";

      const raw = await runTantular({
        system: EXCEL_CHAT_SYSTEM,
        user: `Snapshot workbook:\n"""${contextToPromptText(ctx)}"""\n\nRiwayat singkat:\n${history.toMessages().map((m) => `${m.role}: ${m.content}`).join("\n") || "-"}\n\nPermintaan pengguna:\n"""${message}"""`,
        maxTokens: 1400,
        temperature: 0.1,
        task: "workbook",
        jsonMode: true,
        signal: state.abort.signal
      });

      let parsed = null;
      try {
        parsed = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, ""));
      } catch (_) {
        const match = String(raw).match(/\{[\s\S]*\}/);
        if (match) { try { parsed = JSON.parse(match[0]); } catch (_) { /* below */ } }
      }
      if (!parsed || typeof parsed.reply !== "string") {
        throw new Error("Model tidak mengembalikan rencana JSON yang valid. Coba ulangi atau perjelas permintaannya.");
      }

      const { actions, rejected } = sanitizeExcelActions(parsed.actions);
      answer.textContent = actions.length
        ? `${parsed.reply}\n\nMenjalankan ${actions.length} aksi...`
        : parsed.reply;

      const results = await executeExcelActions(actions);
      const lines = [parsed.reply, "", ...results, ...rejected.map((r) => `⚠️ ${r}`)].filter((l, i) => i < 2 ? true : Boolean(l));
      answer.textContent = lines.join("\n").trim();

      history.add("user", message);
      history.add("assistant", parsed.reply);
    } catch (error) {
      console.error("[TantularChat/Excel]", error, error?.debugInfo);
      answer.textContent = String(error?.message || error || "Terjadi kesalahan.");
      answer.classList.add("error");
    } finally {
      state.busy = false;
      state.abort = null;
      els.stop.classList.add("hidden");
    }
  }
}

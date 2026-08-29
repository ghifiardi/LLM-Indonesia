import { streamedAnswer } from "./index.js";
import { ACTIONS, scopedUserPrompt } from "../../prompts.js";

export function runUbahNada({ instruction, contextText, history, emit, signal }) {
  const action = ACTIONS.word_rewrite;
  if (!contextText) return Promise.resolve({ kind: "text", text: "Pilih teks yang ingin diubah nadanya terlebih dahulu." });
  const user = `Ubah nada teks berikut sesuai instruksi (formal/santai/lainnya) tanpa mengubah makna, nama, dan angka.\n\nInstruksi: ${instruction || "formal"}\n\nTeks:\n"""${contextText.slice(0, action.maxInputChars)}"""`;
  return streamedAnswer({ system: action.system, userText: scopedUserPrompt(action, user), history, emit, signal });
}

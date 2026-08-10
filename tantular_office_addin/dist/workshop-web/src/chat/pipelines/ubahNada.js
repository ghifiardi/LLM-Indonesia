import { streamedAnswer } from "./index.js";
import { ACTIONS, scopedUserPrompt } from "../../prompts.js";

// Canonical system prompt lives in prompts.js ACTIONS.word_rewrite; exported
// here for promptRegistry.js to enumerate/hash without duplicating content.
export const UBAH_NADA_SYSTEM = ACTIONS.word_rewrite.system;

export function runUbahNada({ instruction, contextText, history, emit, signal }) {
  const action = ACTIONS.word_rewrite;
  if (!contextText) return Promise.resolve({ kind: "text", text: "Pilih teks yang ingin diubah nadanya terlebih dahulu." });
  const user = `Ubah nada teks berikut sesuai instruksi (formal/santai/lainnya) tanpa mengubah makna, nama, dan angka.\n\nInstruksi: ${instruction || "formal"}\n\nTeks:\n"""${contextText.slice(0, action.maxInputChars)}"""`;
  return streamedAnswer({ system: action.system, userText: scopedUserPrompt(action, user), history, emit, signal });
}

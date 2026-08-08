import { streamedAnswer } from "./index.js";
import { ACTIONS, scopedUserPrompt } from "../../prompts.js";

export function runRingkas({ instruction, contextText, history, emit, signal }) {
  const action = ACTIONS.word_summarize;
  const text = contextText || "";
  if (!text) return Promise.resolve({ kind: "text", text: "Tidak ada teks untuk diringkas. Pilih teks di dokumen atau ubah pil konteks ke Dokumen (isi utama)." });
  return streamedAnswer({
    system: action.system,
    userText: scopedUserPrompt(action, action.buildUser({ text: text.slice(0, action.maxInputChars), instruction })),
    history, emit, signal
  });
}

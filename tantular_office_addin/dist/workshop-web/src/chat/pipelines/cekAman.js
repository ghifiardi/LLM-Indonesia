import { streamedAnswer } from "./index.js";
import { ACTIONS, scopedUserPrompt } from "../../prompts.js";

export function runCekAman({ instruction, contextText, history, emit, signal }) {
  const action = ACTIONS.scam_check;
  if (!contextText) return Promise.resolve({ kind: "text", text: "Pilih teks yang ingin dicek keamanannya terlebih dahulu." });
  return streamedAnswer({
    system: action.system,
    userText: scopedUserPrompt(action, action.buildUser({ text: contextText.slice(0, action.maxInputChars), instruction })),
    history, emit, signal
  });
}

import { runUmum } from "./umum.js";
import { runRingkas } from "./ringkas.js";
import { runUbahNada } from "./ubahNada.js";
import { runTerjemah } from "./terjemah.js";
import { runCekAman } from "./cekAman.js";
import { runDraftTeks } from "./draftTeks.js";
import { runTantularStream } from "../../tantularClient.js";

const REGISTRY = {
  UMUM: runUmum,
  RINGKAS: runRingkas,
  UBAH_NADA: runUbahNada,
  TERJEMAH: runTerjemah,
  CEK_AMAN: runCekAman,
  DRAFT_TEKS: runDraftTeks,
  // Stage 1B replaces this with the real doc-QA pipeline (Task 7):
  TANYA_DOKUMEN: runUmum,
  // Stage 2 replaces this with the edit-contract pipeline (Task 9):
  EDIT_TEKS: runUmum
};

export function getPipeline(intent) {
  return REGISTRY[intent] ?? runUmum;
}

export function registerPipeline(intent, run) {
  REGISTRY[intent] = run;
}

// Shared: one streamed completion over history + fresh user turn.
export async function streamedAnswer({ system, userText, history, emit, signal, maxTokens = 1024 }) {
  const messages = [
    { role: "system", content: system },
    ...(history?.toMessages() ?? []),
    { role: "user", content: userText }
  ];
  const text = await runTantularStream({ messages, maxTokens, temperature: 0.3, onToken: emit, signal });
  return { kind: "text", text };
}

export function withContext(instruction, contextText, label) {
  if (!contextText) return instruction;
  return `${instruction}\n\n${label}:\n"""${contextText}"""`;
}

// Canonical registry of every production system prompt used by the add-in.
// Each entry is imported from the module that owns it (the module remains the
// single source of truth) — this file only enumerates and hashes them so the
// fine-tuning harness can consume the exact production prompts by import,
// never by copy. Owns prompt content + content hash only; no renderer or
// tokenizer fields belong here.
import { hashText } from "./chat/contextBuilder.js";
import { ROUTER_SYSTEM } from "./chat/intentRouter.js";
import { EDIT_SYSTEM_PROMPT } from "./chat/editContract.js";
import { UMUM_SYSTEM } from "./chat/pipelines/umum.js";
import { RINGKAS_SYSTEM } from "./chat/pipelines/ringkas.js";
import { UBAH_NADA_SYSTEM } from "./chat/pipelines/ubahNada.js";
import { TERJEMAH_SYSTEM } from "./chat/pipelines/terjemah.js";
import { CEK_AMAN_SYSTEM } from "./chat/pipelines/cekAman.js";
import { DRAFT_TEKS_SYSTEM } from "./chat/pipelines/draftTeks.js";
import { TANYA_DOKUMEN_SYSTEM } from "./chat/pipelines/tanyaDokumen.js";

const CONTENT = {
  router: ROUTER_SYSTEM,
  edit: EDIT_SYSTEM_PROMPT,
  "prose:umum": UMUM_SYSTEM,
  "prose:ringkas": RINGKAS_SYSTEM,
  "prose:ubahNada": UBAH_NADA_SYSTEM,
  "prose:terjemah": TERJEMAH_SYSTEM,
  "prose:cekAman": CEK_AMAN_SYSTEM,
  "prose:draftTeks": DRAFT_TEKS_SYSTEM,
  "prose:tanyaDokumen": TANYA_DOKUMEN_SYSTEM
};

export const PROMPT_IDS = Object.freeze(Object.keys(CONTENT));

export function allPromptIds() {
  return [...PROMPT_IDS];
}

export function getPrompt(id) {
  if (!(id in CONTENT)) throw new Error(`unknown prompt id: ${id}`);
  return { id, content: CONTENT[id], contentHash: hashText(CONTENT[id]) };
}

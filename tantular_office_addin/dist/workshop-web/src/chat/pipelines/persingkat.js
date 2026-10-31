import { streamedAnswer } from "./index.js";
import { ACTIONS, scopedUserPrompt } from "../../prompts.js";

// "Buat lebih singkat" on a bounded span (a live selection or the verified
// result of an approved edit). It must NOT use RINGKAS: that prompt hard-codes
// "3-7 bullet", which turned one edited sentence into seven bullets with
// invented statements (Word acceptance, 2026-10-17). Not a router intent; the
// intent taxonomy in intentRouter.js stays the single owner of those names.
export const SHORTEN_REQUEST = /\b(lebih\s+(?:singkat|pendek|ringkas|padat)|persingkat(?:kan)?|perpendek|shorter|more\s+concise)\b/i;

export function isShortenRequest(message) {
  return SHORTEN_REQUEST.test(String(message ?? ""));
}

export const NOT_SHORTER_MESSAGE =
  "Saya tidak berhasil mempersingkat bagian ini tanpa menambah isi, jadi teks aslinya saya biarkan. Coba beri petunjuk, misalnya bagian mana yang boleh dihilangkan.";

export async function runPersingkat({ instruction, contextText, history, emit, signal }, { stream = streamedAnswer } = {}) {
  const action = ACTIONS.word_rewrite;
  const source = String(contextText ?? "").slice(0, action.maxInputChars);
  if (!source.trim()) return { kind: "text", text: "Pilih teks yang ingin dipersingkat terlebih dahulu." };
  const user = [
    "Persingkat teks berikut agar lebih pendek dari aslinya.",
    "Pertahankan makna, nama, dan angka. Jangan menambah fakta, saran, atau kalimat baru.",
    "Jangan gunakan bullet atau daftar. Keluarkan hanya teks hasilnya, satu kalimat atau satu paragraf pendek.",
    "",
    `Instruksi pengguna: ${instruction || "buat lebih singkat"}`,
    "",
    `Teks:\n"""${source}"""`
  ].join("\n");
  const result = await stream({ system: action.system, userText: scopedUserPrompt(action, user), history, emit, signal, maxTokens: 512 });
  // A "shortening" that is not shorter is a failure, not an answer.
  if (result.kind === "text" && result.text.trim().length >= source.trim().length) {
    return { kind: "text", text: NOT_SHORTER_MESSAGE };
  }
  return result;
}

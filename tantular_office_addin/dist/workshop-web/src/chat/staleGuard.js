// Fail-closed checks for "the source changed while we were working".
// Revisions are invalidation keys (length + short hash), not authorization.
import { bodyRevision } from "./contextBuilder.js";

export const STALE_ANSWER_MESSAGE =
  "Dokumen berubah saat jawaban disusun, jadi jawaban tadi dibuang agar tidak memakai versi lama. Kirim ulang pertanyaan Anda.";
export const STALE_PREVIEW_MESSAGE =
  "Dokumen berubah sejak usulan edit dibuat. Usulan ini tidak diterapkan; minta usulan edit yang baru.";

// context: { kind: "document"|"selection"|"none", revision?, text }
export async function contextIsCurrent(context, { readBody, readSelection }) {
  if (context.kind === "document") return bodyRevision(await readBody()) === context.revision;
  if (context.kind === "selection") return (await readSelection()) === context.text;
  return true;
}

// Run `apply` only if the document still matches the revision the preview was
// built from. A missing expectedRevision is treated as stale (fail closed).
export async function applyIfCurrent({ expectedRevision, readBody, apply }) {
  if (!expectedRevision) return { stale: true };
  if (bodyRevision(await readBody()) !== expectedRevision) return { stale: true };
  return { stale: false, results: await apply() };
}

// Tantular Deck Studio — document/PDF extraction client.
// Talks to the local Python companion through the HTTPS dev server proxy.
// This avoids mixed-content/localhost blocking in the PowerPoint desktop webview.

import { assertCompanionAvailable, companionUrl } from "../companionUrl.js";

// Resolved lazily, never at module load: Office.context.host only exists after
// onReady, and the active mode can change mid-session from Pengaturan.
const docExtractUrl = () => companionUrl("/api/document-extract");
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Pure, testable upload-size guard. Throws the Indonesian error the UI
// surfaces to the user; kept separate from extractDocumentFile so tests can
// exercise the boundary without mocking fetch/FormData.
export function assertUploadSize(file) {
  if (!file) throw new Error("Tidak ada file dokumen.");
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("File terlalu besar (maks 100 MB).");
  }
}

export async function extractDocumentFile(file, endpoint = null) {
  assertUploadSize(file);

  // Lightweight direct browser extraction for simple text files.
  // This path needs no companion at all, so it keeps working in cloud mode —
  // the guard below sits after it, in front of the network call.
  if (isPlainText(file.name, file.type)) {
    const text = await file.text();
    return {
      filename: file.name,
      kind: "text",
      text: cleanText(text),
      chars: cleanText(text).length
    };
  }

  // Companion-only: PDF/DOCX/PPTX extraction runs in the local Python server.
  assertCompanionAvailable("Membaca file dokumen (PDF/DOCX/PPTX)");

  const form = new FormData();
  form.append("file", file, file.name);
  let response;
  try {
    response = await fetch(endpoint || docExtractUrl(), { method: "POST", body: form });
  } catch {
    throw new Error(
      "Document extractor belum berjalan. Jalankan di terminal: npm run doc-server"
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Document extractor gagal (${response.status}).`);
  }
  return payload;
}

function isPlainText(name, type) {
  const lower = String(name || "").toLowerCase();
  return /^text\//i.test(type || "") || /\.(txt|md|markdown|csv|tsv|json|log)$/i.test(lower);
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, 80_000);
}

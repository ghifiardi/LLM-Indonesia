// Tantular Deck Studio — document/PDF extraction client.
// Talks to the local Python companion through the HTTPS dev server proxy.
// This avoids mixed-content/localhost blocking in the PowerPoint desktop webview.

const DEFAULT_DOC_EXTRACT_URL = "/api/document-extract";

export async function extractDocumentFile(file, endpoint = DEFAULT_DOC_EXTRACT_URL) {
  if (!file) throw new Error("Tidak ada file dokumen.");
  if (file.size > 35 * 1024 * 1024) throw new Error("File terlalu besar (maks 35 MB). ");

  // Lightweight direct browser extraction for simple text files.
  if (isPlainText(file.name, file.type)) {
    const text = await file.text();
    return {
      filename: file.name,
      kind: "text",
      text: cleanText(text),
      chars: cleanText(text).length
    };
  }

  const form = new FormData();
  form.append("file", file, file.name);
  let response;
  try {
    response = await fetch(endpoint, { method: "POST", body: form });
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

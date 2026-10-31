function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function htmlToText(html, { maxChars = 30_000 } = {}) {
  return decodeHtml(String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|p|div|li|tr|h[1-6]|section|article|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

export function extractFetchedText({ body, contentType }, { maxChars = 30_000 } = {}) {
  if (contentType === "application/pdf") {
    return { ok: false, reason: "pdf_extractor_required", text: "" };
  }
  const raw = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  const text = contentType === "text/html" || contentType === "application/xhtml+xml"
    ? htmlToText(raw, { maxChars })
    : raw.trim().slice(0, maxChars);
  if (text.length < 80) return { ok: false, reason: "too_little_text", text };
  return { ok: true, text };
}

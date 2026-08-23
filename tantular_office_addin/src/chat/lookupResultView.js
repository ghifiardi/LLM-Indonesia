// How a lookup result is rendered. Two states, and they must not blur.
//
//   verified   the answer passed the check against the user's document. Show
//              the text; editing is allowed.
//   blocked    the answer failed, or could not be checked. Show WHY. Never
//              show the text, never offer an edit.
//
// A pure view model, so both states are tested without a DOM and without
// Office. The pane renders what this returns and adds no answer of its own.
//
// The dangerous rendering bug is not showing a scary message when things are
// fine — it is showing an answer that failed verification as though it passed.
// So `answer` is null on every path except a verified one, and `canEdit`
// derives from the same value rather than being set separately: two fields
// that can disagree eventually will.

// Findings come from the verifier as machine names. The user needs to know
// what went wrong in their own terms, and a raw `no_new_facts` tells them
// nothing about their document.
const FINDING_LABELS = Object.freeze({
  preserves: "Ada fakta dari dokumen Anda yang hilang atau berubah di jawaban.",
  no_new_facts: "Jawaban memuat angka, tanggal, atau nama yang tidak ada di "
    + "dokumen Anda maupun di halaman sumber.",
  untrusted_echo: "Jawaban mengikuti format yang diminta oleh halaman web, "
    + "bukan oleh Anda.",
  fail_closed: "Pemeriksaan tidak dapat dijalankan."
});

const REASON_MESSAGES = Object.freeze({
  failed_verification: "Jawaban tidak lolos pemeriksaan terhadap dokumen Anda.",
  no_document: "Tidak ada dokumen untuk memeriksa jawaban.",
  no_answer: "Model tidak menghasilkan jawaban.",
  verifier_unavailable: "Pemeriksa jawaban tidak tersedia.",
  verifier_error: "Pemeriksa jawaban gagal dijalankan.",
  model_error: "Model gagal menjawab.",
  document_changed: "Dokumen berubah setelah Anda menyetujui pencarian.",
  disabled: "Pencarian web dimatikan.",
  host_not_allowed: "Host itu tidak ada dalam daftar yang diizinkan.",
  no_adapter: "Host itu belum punya adapter pencarian.",
  mismatch: "Query berubah setelah disetujui.",
  expired: "Persetujuan kedaluwarsa.",
  unknown_token: "Permintaan tidak dikenal atau sudah dipakai."
});

export function explainFindings(findings) {
  if (!findings || typeof findings !== "object") return [];
  return Object.entries(findings).map(([kind, details]) => ({
    kind,
    label: FINDING_LABELS[kind] || `Pemeriksaan '${kind}' gagal.`,
    // The raw strings are kept so a user can see the specific vendor or figure
    // rather than only a category. This is their own document, not a secret.
    details: Array.isArray(details) ? details.map(String) : [String(details)]
  }));
}

export function lookupResultView(response) {
  // A missing or malformed response is a BLOCKED state, not an empty one.
  // Rendering nothing would look like a lookup that simply returned little.
  if (!response || typeof response !== "object") {
    return {
      state: "blocked", canEdit: false, answer: null,
      title: "Hasil tidak dapat ditampilkan",
      message: "Tidak ada respons yang bisa dibaca dari Companion.",
      findings: [], host: null
    };
  }

  const host = response.host ? String(response.host) : null;

  // Only this exact shape is trusted. `ok === true` alone is not enough: an
  // older or partial response could carry ok without having been verified.
  if (response.ok === true && response.status === "verified"
      && String(response.answer || "").trim()) {
    return {
      state: "verified", canEdit: true, answer: String(response.answer),
      title: "Jawaban terverifikasi",
      message: "Jawaban ini sudah dicocokkan dengan dokumen Anda.",
      findings: [], host,
      // What was checked, so "terverifikasi" is inspectable rather than a badge.
      protectedStrings: Array.isArray(response.protected)
        ? response.protected.map(String) : []
    };
  }

  const reason = String(response.reason || "unknown");
  return {
    state: "blocked", canEdit: false, answer: null,
    title: "Jawaban ditahan",
    message: REASON_MESSAGES[reason]
      || "Jawaban tidak lolos pemeriksaan dan tidak ditampilkan.",
    reason,
    findings: explainFindings(response.findings),
    host,
    note: "Teks jawaban tidak ditampilkan karena tidak lolos pemeriksaan."
  };
}

// Escaping is the pane's job, but doing it here means the one function that
// builds the HTML is also the one that is tested. A finding string can contain
// text from a hostile web page.
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function renderLookupResultHtml(response) {
  const view = lookupResultView(response);
  const hostLine = view.host
    ? `<div class="lookup-host">Sumber: ${escapeHtml(view.host)}</div>` : "";

  if (view.state === "verified") {
    const checked = view.protectedStrings.length
      ? `<div class="lookup-checked">Dicocokkan: `
        + view.protectedStrings.map((s) => escapeHtml(s)).join(", ") + `</div>`
      : "";
    return `<div class="lookup-result lookup-verified" data-state="verified">`
      + `<div class="lookup-title">✅ ${escapeHtml(view.title)}</div>`
      + hostLine
      + `<div class="lookup-answer">${escapeHtml(view.answer)}</div>`
      + checked
      + `<button type="button" class="lookup-edit" data-can-edit="true">`
      + `Terapkan sebagai edit</button></div>`;
  }

  const findings = view.findings.length
    ? `<ul class="lookup-findings">` + view.findings.map((f) =>
        `<li><strong>${escapeHtml(f.label)}</strong>`
        + (f.details.length
            ? `<ul>` + f.details.map((d) => `<li>${escapeHtml(d)}</li>`).join("") + `</ul>`
            : "")
        + `</li>`).join("") + `</ul>`
    : "";
  // No answer element and no edit button exist in this branch at all — not
  // hidden ones. A hidden button is one CSS mistake away from being a live one.
  return `<div class="lookup-result lookup-blocked" data-state="blocked">`
    + `<div class="lookup-title">⛔ ${escapeHtml(view.title)}</div>`
    + hostLine
    + `<div class="lookup-message">${escapeHtml(view.message)}</div>`
    + findings
    + `<div class="lookup-note">${escapeHtml(view.note)}</div></div>`;
}

// Mount into the pane. Separated from the string builder so the rendering can
// be tested without a DOM — this repo has no jsdom and no dependencies, and
// adding one to test six lines is the wrong trade.
//
// The edit handler is attached ONLY in the verified branch. Attaching it always
// and checking a flag inside would put the decision in the handler, where a
// later edit could lose it; here the callback does not exist unless the answer
// passed.
export function mountLookupResult(container, response, { onEdit } = {}) {
  if (!container) return null;
  const view = lookupResultView(response);
  container.innerHTML = renderLookupResultHtml(response);
  if (view.state !== "verified") return view;

  const button = container.querySelector?.(".lookup-edit");
  if (button && typeof onEdit === "function") {
    button.addEventListener("click", () => onEdit(view.answer));
  }
  return view;
}

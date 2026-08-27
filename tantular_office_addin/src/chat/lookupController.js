// The pane's lookup code path, end to end.
//
//   read the real document  →  prepare  →  show host+query  →  approve
//                           →  execute with the SAME token and document
//                           →  render verified or blocked
//
// Everything is injected, so the whole sequence is tested with Office mocks and
// a fake companion. The pane supplies the real ones.
//
// TWO INVARIANTS, both enforced here rather than by discipline:
//
//   1. The document goes to the LOCAL COMPANION ONLY. `postLocal` is the single
//      transport and it is the only thing given the document; the query alone
//      is what the companion forwards. Nothing in this file can construct a
//      remote URL.
//   2. The document sent to execute is the SAME BYTES read before prepare. It
//      is read once and reused, never re-read — a re-read could return an
//      edited document that the user never approved, and the companion would
//      reject it as document_changed after the query had already gone out.

import { searchAllowed, approvalDialogModel } from "./lookupUi.js";
import { readLookupDocument } from "./lookupDocument.js";
import { mountLookupResult } from "./lookupResultView.js";

// The disclosure the user reads must name what leaves and what does not. Users
// approve "search the web" without a clear idea of what travels; saying it
// twice, in the dialog and in the banner, is cheap.
export function disclosureWithDocumentNote(dialog, documentInfo) {
  return {
    ...dialog,
    documentSource: documentInfo?.source || "",
    documentNote: "Isi dokumen TIDAK dikirim ke internet. Dokumen hanya dipakai "
      + "secara lokal untuk memeriksa jawaban.",
    truncatedNote: documentInfo?.truncated
      ? "Dokumen dipotong karena sangat panjang; pemeriksaan memakai bagian awal saja."
      : ""
  };
}

export function createLookupController({
  postLocal,            // (path, body) -> Promise<response>   LOCAL companion only
  confirm,              // (dialog) -> Promise<boolean>
  container,            // element for the result
  readDocument = readLookupDocument,
  onEdit = null,
  getHost                // () -> "Word" | "Excel" | "PowerPoint"
}) {
  const show = (response) => {
    mountLookupResult(container, response, { onEdit });
    if (container) container.hidden = false;
    return response;
  };

  return async function runLookup({ mode, query, host: chosenHost, provider }) {
    // The pane's picker chooses among allowed hosts; enforcement is NOT here.
    // The companion's allowlist and adapter checks decide what is reachable —
    // a pane bug can at worst ask for a host the server will refuse.
    const HOST_CHOSEN = String(chosenHost || HOST).trim().toLowerCase();
    const PROVIDER_CHOSEN = String(provider || "").trim().toLowerCase();
    if (!searchAllowed(mode)) {
      // Mode Lokal is a printed promise. Nothing may be read or sent here.
      return show({ ok: false, reason: "disabled",
                    message: "Pencarian mati di Mode Lokal." });
    }
    const text = String(query || "").trim();
    if (!text) {
      return show({ ok: false, reason: "empty_query",
                    message: "Tulis dulu yang ingin dicari." });
    }

    // Read the document BEFORE prepare, so a document that cannot be read
    // costs no outbound request at all.
    const doc = await readDocument(getHost());
    if (!doc?.ok) {
      return show({ ok: false, reason: doc?.reason || "read_failed",
                    message: doc?.message || "Dokumen tidak dapat dibaca." });
    }
    const document = doc.text;

    const prepared = await postLocal("/api/lookup/prepare",
      { query: text, ...(PROVIDER_CHOSEN
        ? { provider: PROVIDER_CHOSEN } : { host: HOST_CHOSEN }), document });
    if (!prepared?.ok || !prepared.token) {
      return show({ ok: false, reason: prepared?.reason || "prepare_failed",
                    message: prepared?.message || "Permintaan ditolak.",
                    host: PROVIDER_CHOSEN || HOST_CHOSEN });
    }

    const dialog = approvalDialogModel(prepared.disclosure);
    if (!dialog.valid) {
      return show({ ok: false, reason: "nothing_to_show",
                    message: "Tidak ada yang bisa ditinjau; permintaan dibatalkan." });
    }

    // A dialog that cannot run is a refusal, not an exception. Before this
    // guard, real Excel's failing window.confirm() rejected the whole chain
    // silently: buttons recovered (finally), nothing rendered, and the click
    // appeared to do nothing at all.
    let approved = false;
    try {
      approved = await confirm(disclosureWithDocumentNote(dialog, doc));
    } catch {
      approved = false;
    }
    if (!approved) {
      // No execute call is made. This is an unmade request, not a cancelled
      // one: nothing has left the machine.
      return show({ ok: false, reason: "declined",
                    message: "Dibatalkan. Tidak ada yang dikirim keluar.",
                    host: PROVIDER_CHOSEN || HOST_CHOSEN });
    }

    // The exact bytes the user read, and the exact document they were read
    // against. Re-composing either here would defeat the approval.
    const executed = await postLocal("/api/lookup/execute", {
      token: prepared.token,
      query: prepared.disclosure.query,
      ...(prepared.disclosure.provider
        ? { provider: prepared.disclosure.provider }
        : { host: prepared.disclosure.host }),
      document
    });
    return show(executed);
  };
}

// One host, one adapter. Hard-coded rather than passed in: a caller-supplied
// host is a caller-supplied egress target, and the allowlist already lives in
// the companion. Adding a host means adding an adapter there first.
export const HOST = "id.wikipedia.org";

// The transport, and the only one this feature may use.
//
// `companionUrl()` routes to the CLOUD gateway when the user has chosen Mode
// Cloud. The document must never go there: it is read for local verification
// only, and the whole promise printed in the pane is that it stays on this
// machine. So this refuses outright in a cloud session rather than quietly
// posting the document to a remote endpoint.
export function createLocalCompanionPost({
  fetchImpl,
  isCloudSession,
  companionUrl,
  // Injected in tests. In a browser this is the page that a relative companion
  // URL would actually resolve against.
  getPageUrl = () => globalThis.location?.href || "https://localhost/"
}) {
  return async function postLocal(path, body, { timeoutMs = 0 } = {}) {
    if (isCloudSession()) {
      return { ok: false, reason: "cloud_session",
               message: "Pencarian hanya tersedia dengan Tantular Companion lokal; "
                        + "dokumen tidak dikirim ke server." };
    }
    const url = companionUrl(path);
    // Resolve relative paths too. `/api/...` is local on the localhost dev
    // server, but it is a REMOTE same-origin request when the identical pane is
    // opened on the hosted portal. Checking only already-absolute URLs would
    // silently let the document follow that relative path off the machine.
    let resolved;
    try {
      resolved = new URL(url, getPageUrl());
    } catch {
      return { ok: false, reason: "not_local",
               message: "Alamat Companion tidak valid; permintaan dibatalkan." };
    }
    const hostname = resolved.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)
        || !["http:", "https:"].includes(resolved.protocol)) {
      return { ok: false, reason: "not_local",
               message: "Companion bukan lokal; permintaan dibatalkan." };
    }
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(new DOMException("Timeout", "AbortError")), timeoutMs)
      : null;
    try {
      const response = await fetchImpl(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {})
      });
      return await response.json();
    } catch (error) {
      if (controller?.signal.aborted || error?.name === "AbortError") {
        return { ok: false, reason: "timeout",
                 message: "Companion terlalu lama merespons. Coba lagi." };
      }
      return { ok: false, reason: "companion_unreachable",
               message: `Tidak bisa menghubungi Companion: ${error?.message || error}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

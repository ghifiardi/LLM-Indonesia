// The pane half of approval-gated lookup: mode state and the approval flow.
//
// Kept out of taskpane.js so it can be tested without Office. The pane owns the
// elements; this owns the rules about when a request may be sent.
//
// The mode is deliberately visible and deliberately off. "Mode Lokal" is a
// promise printed in the pane — that document text does not leave the machine —
// and a feature that quietly weakens it would make the banner a lie.

export const MODE_LOCAL = "local";
export const MODE_LOCAL_SEARCH = "local+search";

export const MODE_LABELS = Object.freeze({
  [MODE_LOCAL]: "Mode Lokal",
  [MODE_LOCAL_SEARCH]: "Mode Lokal + Pencarian",
});

export const MODE_BANNERS = Object.freeze({
  [MODE_LOCAL]:
    "🔒 Mode Lokal — teks dokumen Anda tidak keluar dari komputer ini.",
  [MODE_LOCAL_SEARCH]:
    "🌐 Mode Lokal + Pencarian — dokumen tetap lokal; hanya query yang Anda "
    + "setujui yang dikirim keluar.",
});

// Default off. Anything unrecognised falls back to local rather than search:
// a corrupted setting must not silently enable egress.
export function normaliseMode(value) {
  return value === MODE_LOCAL_SEARCH ? MODE_LOCAL_SEARCH : MODE_LOCAL;
}

export function bannerFor(mode) {
  return MODE_BANNERS[normaliseMode(mode)];
}

export function searchAllowed(mode) {
  return normaliseMode(mode) === MODE_LOCAL_SEARCH;
}

// Wire the deliberately small lookup entry surface without depending on a DOM
// library. Keeping it here makes the important negative behavior testable:
// off means hidden controls and a cleared result; one click means one run with
// the mode and query captured before the approval flow starts.
export function bindLookupEntry({ toggle, controls, input, button, result, run }) {
  let mode = MODE_LOCAL;
  let running = false;

  const clearResult = () => {
    if (!result) return;
    result.innerHTML = "";
    result.hidden = true;
  };

  const applyToggle = () => {
    mode = toggle?.checked ? MODE_LOCAL_SEARCH : MODE_LOCAL;
    if (controls) controls.hidden = mode === MODE_LOCAL;
    if (mode === MODE_LOCAL) clearResult();
    else input?.focus?.();
    return mode;
  };

  const execute = async (query) => {
    if (running) return { ok: false, reason: "busy" };
    running = true;
    if (toggle) toggle.disabled = true;
    if (input) input.disabled = true;
    if (button) button.disabled = true;
    try {
      return await run({ mode, query: String(query ?? "") });
    } finally {
      running = false;
      if (toggle) toggle.disabled = false;
      if (input) input.disabled = false;
      if (button) button.disabled = false;
    }
  };

  if (toggle) {
    toggle.checked = false;
    toggle.addEventListener("change", applyToggle);
  }
  if (controls) controls.hidden = true;
  button?.addEventListener("click", () => execute(input?.value));
  input?.addEventListener("keydown", (event) => {
    if (event?.key !== "Enter") return;
    event.preventDefault?.();
    return execute(input.value);
  });

  return {
    run: (query) => execute(query),
    getMode: () => mode
  };
}

// What the dialog must show. The user approves THIS, byte for byte, and the
// server will refuse anything else.
export function approvalDialogModel(disclosure) {
  const host = String(disclosure?.host || "").trim();
  const query = String(disclosure?.query || "");
  return {
    title: "Setujui pencarian web?",
    host,
    query,
    warning: `Teks berikut akan dikirim ke ${host} dan keluar dari komputer Anda.`,
    // Shown so a user can see at a glance whether the model smuggled document
    // content into the query.
    chars: query.length,
    approveLabel: "Setujui",
    cancelLabel: "Batal",
    valid: Boolean(host && query.trim()),
  };
}

// The flow, as a state machine, so "no approval means no request" is a property
// of the code rather than of how carefully the pane was written.
export function createApprovalFlow({ prepare, execute, confirm }) {
  return async function lookup({ mode, query, host }) {
    if (!searchAllowed(mode)) {
      return { ok: false, reason: "mode_local",
               message: "Pencarian mati di Mode Lokal." };
    }
    const prepared = await prepare({ query, host });
    if (!prepared?.ok) {
      return { ok: false, reason: prepared?.reason || "prepare_failed",
               message: prepared?.message || "Permintaan ditolak." };
    }
    const dialog = approvalDialogModel(prepared.disclosure);
    if (!dialog.valid) {
      return { ok: false, reason: "nothing_to_show",
               message: "Tidak ada yang bisa ditinjau; permintaan dibatalkan." };
    }
    const approved = await confirm(dialog);
    if (!approved) {
      // No execute call at all — not a cancelled request, an unmade one.
      return { ok: false, reason: "declined", message: "Dibatalkan oleh pengguna." };
    }
    // The token binds the exact bytes the user just read; execute sends the
    // SAME query, never a re-composed one.
    return execute({ token: prepared.token,
                     query: prepared.disclosure.query,
                     host: prepared.disclosure.host });
  };
}

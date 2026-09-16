import { locateEdit, searchOrdinalAt } from "./editContract.js";
import { companionUrl } from "../companionUrl.js";

function hasWordApi14() {
  return globalThis.Office?.context?.requirements?.isSetSupported?.("WordApi", "1.4") ?? false;
}

export function renderEditPreview({ container, edits, addBubble }) {
  const wrap = document.createElement("div");
  wrap.className = "chat-bubble assistant edit-preview";
  const resolvable = edits.filter((e) => !e.error);
  if (resolvable.length === 0) {
    addBubble("error", "Tidak ada edit yang bisa dijangkarkan ke dokumen. Coba pilih teksnya lalu ulangi.");
    return;
  }
  const rows = edits.map((item, i) => {
    const row = document.createElement("label");
    row.className = "edit-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !item.error;
    checkbox.disabled = Boolean(item.error);
    const desc = document.createElement("details");
    desc.className = "edit-detail";
    const status = item.error === "not_found" ? " ⚠ tidak ditemukan"
      : item.error === "ambiguous" ? " ✖ ambigu, dilewati" : "";
    const summary = document.createElement("summary");
    summary.textContent = `Edit ${i + 1}${item.edit.alasan ? ` — ${item.edit.alasan}` : ""}${status}`;
    const oldLabel = document.createElement("strong");
    oldLabel.textContent = "Teks lama";
    const oldText = document.createElement("div");
    oldText.className = "edit-old";
    oldText.textContent = item.edit.find;
    const newLabel = document.createElement("strong");
    newLabel.textContent = "Teks baru";
    const newText = document.createElement("div");
    newText.className = "edit-new";
    newText.textContent = item.edit.replace;
    desc.append(summary, oldLabel, oldText, newLabel, newText);
    row.append(checkbox, desc);
    row.dataset.index = String(i);
    return { row, checkbox, item, originalDisabled: checkbox.disabled };
  });
  rows.forEach(({ row }) => wrap.appendChild(row));
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "primary";
  let applying = false;
  const refreshLabel = () => {
    if (applying) return;
    const n = rows.filter((r) => r.checkbox.checked).length;
    apply.textContent = `Terapkan (${n})`;
    apply.disabled = n === 0;
  };
  rows.forEach(({ checkbox }) => checkbox.addEventListener("change", refreshLabel));
  refreshLabel();
  if (!hasWordApi14()) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "Versi Word ini tidak mendukung tracked changes; edit akan diterapkan langsung (gunakan Undo untuk membatalkan).";
    wrap.appendChild(note);
  }
  apply.addEventListener("click", async () => {
    applying = true;
    apply.disabled = true;
    rows.forEach(({ checkbox }) => { checkbox.disabled = true; });
    try {
      const chosen = rows.filter((r) => r.checkbox.checked).map((r) => r.item.edit);
      // SINGLE EDIT ONLY. Office.js has no transaction across context.sync(),
      // so a batch that fails halfway leaves earlier edits applied with no way
      // to roll them back. Refusing here is the honest scope; the alternative
      // is a receipt that claims an atomicity the platform does not provide.
      if (chosen.length > 1) {
        addBubble("error",
          `Hanya satu edit per persetujuan (${chosen.length} dipilih). `
          + "Centang satu edit, terapkan, lalu ulangi untuk yang berikutnya.");
        return;
      }
      const results = await applyApprovedEdit(chosen[0]);
      const lines = results.map((r) =>
        r.status === "applied" ? `✔ diterapkan: "${r.edit.find}"`
          : r.status === "not_found" ? `⚠ tidak ditemukan: "${r.edit.find}"`
            : r.status === "refused" ? `✖ ditolak: ${r.reason ?? "persetujuan tidak sah"}`
              : `✖ dilewati (ambigu): "${r.edit.find}"`);
      addBubble("assistant", lines.join("\n"));
    } catch (error) {
      addBubble("error", String(error?.message ?? error));
    } finally {
      applying = false;
      rows.forEach(({ checkbox, originalDisabled }) => { checkbox.disabled = originalDisabled; });
      refreshLabel();
    }
  });
  wrap.appendChild(apply);
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
}

export async function applyTrackedEdits(edits) {
  if (!globalThis.Word) throw new Error("Fitur edit membutuhkan Word JavaScript API.");
  const hasTracking = hasWordApi14();

  const results = [];
  await Word.run(async (context) => {
    const doc = context.document;
    let priorMode = null;
    if (hasTracking) {
      doc.load("changeTrackingMode");
      await context.sync();
      priorMode = doc.changeTrackingMode;
      doc.changeTrackingMode = Word.ChangeTrackingMode.trackAll;
    }
    try {
      for (const edit of edits) {
        // Apply-time revalidation (spec): the document may have changed since
        // preview, and prior edits in this loop may have shifted text. Re-read
        // the body and re-anchor every edit against the CURRENT state; stale
        // anchors must never replace the wrong text.
        const bodyRange = context.document.body;
        bodyRange.load("text");
        await context.sync();
        const bodyNow = bodyRange.text ?? "";
        const r = locateEdit(bodyNow, edit);
        if (r.error) {
          results.push({ edit, status: r.error === "not_found" ? "not_found" : "skipped" });
          continue;
        }
        // locateEdit may resolve via its whitespace-normalized retry, in
        // which case edit.find does NOT occur literally at r.index. Anchor
        // on the text that actually matched so the ordinal lookup and the
        // Word search agree with what locateEdit found.
        const matchedText = bodyNow.slice(r.index, r.index + r.length);
        if (matchedText.length > 250) {
          results.push({ edit, status: "not_found" });
          continue;
        }
        const nth = searchOrdinalAt(bodyNow, matchedText, r.index);
        if (nth === -1) {
          results.push({ edit, status: "not_found" });
          continue;
        }
        const found = doc.body.search(matchedText, { matchCase: true });
        found.load("items");
        await context.sync();
        if (!found.items[nth]) {
          results.push({ edit, status: "not_found" });
          continue;
        }
        found.items[nth].insertText(edit.replace, Word.InsertLocation.replace);
        await context.sync();
        results.push({ edit, status: "applied" });
      }
    } finally {
      if (hasTracking && priorMode !== null) {
        doc.changeTrackingMode = priorMode;
        await context.sync();
      }
    }
  });
  return results;
}

// Read the live document and resolve ONE edit against it, without mutating
// anything. Separated from the apply so the approval can be minted against
// exactly the state the user is looking at, and so the same resolution can be
// repeated at execute to prove it has not moved.
export async function resolveAgainstDocument(edit) {
  if (!globalThis.Word) throw new Error("Fitur edit membutuhkan Word JavaScript API.");
  return Word.run(async (context) => {
    const bodyRange = context.document.body;
    bodyRange.load("text");
    await context.sync();
    const documentText = bodyRange.text ?? "";
    const r = locateEdit(documentText, edit);
    if (r.error) return { documentText, error: r.error };
    const matchedText = documentText.slice(r.index, r.index + r.length);
    // Same 250-character ceiling applyTrackedEdits enforces: Word's search
    // cannot reliably anchor a longer span, and a span it cannot anchor must
    // fail as not_found rather than land somewhere approximate.
    if (matchedText.length > 250) return { documentText, error: "not_found" };
    const ordinal = searchOrdinalAt(documentText, matchedText, r.index);
    if (ordinal === -1) return { documentText, error: "not_found" };
    return { documentText, matchedText, ordinal };
  });
}

async function postJson(pathname, payload) {
  const response = await fetch(companionUrl(pathname), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  let data = null;
  try { data = await response.json(); } catch { /* handled below */ }
  if (!data) throw new Error(`Companion tidak menjawab untuk ${pathname}.`);
  return { status: response.status, data };
}

/**
 * Apply ONE edit through the approval protocol.
 *
 * Nothing here decides that the edit is permitted. The pane resolves the edit,
 * shows it, and asks the companion; the companion mints a token bound to the
 * document, the target and the change, and consumes it once. The pane cannot
 * authorise itself, which is the property that makes an applied edit evidence
 * of a user decision rather than of a button press.
 */
export async function applyApprovedEdit(edit) {
  if (!edit) return [];
  const located = await resolveAgainstDocument(edit);
  if (located.error) {
    return [{ edit, status: located.error === "not_found" ? "not_found" : "skipped" }];
  }

  const prepared = await postJson("/api/edit/prepare", {
    edits: [edit],
    document: located.documentText,
    located: { matchedText: located.matchedText, ordinal: located.ordinal }
  });
  if (!prepared.data.ok) {
    return [{ edit, status: "refused", reason: prepared.data.reason }];
  }

  // Re-resolve against the CURRENT document before spending the token. The
  // companion recomputes the bindings from what is sent here, so a document
  // that moved between preview and apply is refused there rather than being
  // asserted away here.
  const now = await resolveAgainstDocument(edit);
  if (now.error) {
    return [{ edit, status: now.error === "not_found" ? "not_found" : "skipped" }];
  }

  const executed = await postJson("/api/edit/execute", {
    token: prepared.data.token,
    edit,
    document: now.documentText,
    located: { matchedText: now.matchedText, ordinal: now.ordinal }
  });
  if (!executed.data.ok) {
    return [{ edit, status: "refused", reason: executed.data.reason }];
  }

  let results;
  try {
    results = await applyTrackedEdits([edit]);
  } catch (error) {
    // The approval was spent and the edit did not land. Report that, so the
    // audit does not show an authorised edit with no outcome.
    await postJson("/api/edit/result", {
      idempotency_key: executed.data.idempotency_key, status: "error"
    }).catch(() => { /* the throw below is the user-visible failure */ });
    throw error;
  }
  const status = results[0]?.status ?? "unknown";
  await postJson("/api/edit/result", {
    idempotency_key: executed.data.idempotency_key, status
  }).catch(() => { /* a dropped result row must not undo a real edit */ });
  return results;
}

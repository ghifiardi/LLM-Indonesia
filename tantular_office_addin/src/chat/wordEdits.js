import { locateEdit, searchOrdinalAt } from "./editContract.js";

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
    const desc = document.createElement("span");
    const status = item.error === "not_found" ? " ⚠ tidak ditemukan"
      : item.error === "ambiguous" ? " ✖ ambigu, dilewati" : "";
    desc.textContent = `"${item.edit.find}" → "${item.edit.replace}"${item.edit.alasan ? ` — ${item.edit.alasan}` : ""}${status}`;
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
      const results = await applyTrackedEdits(chosen);
      const lines = results.map((r) =>
        r.status === "applied" ? `✔ diterapkan: "${r.edit.find}"`
          : r.status === "not_found" ? `⚠ tidak ditemukan: "${r.edit.find}"`
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
        const nth = searchOrdinalAt(bodyNow, edit.find, r.index);
        if (nth === -1) {
          results.push({ edit, status: "not_found" });
          continue;
        }
        const found = doc.body.search(edit.find, { matchCase: true });
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

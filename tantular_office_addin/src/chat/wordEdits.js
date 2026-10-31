import { resolveEditAnchor, escapeWordSearch, rangeMatchesPlan } from "./editContract.js";
import { applyIfCurrent, STALE_PREVIEW_MESSAGE } from "./staleGuard.js";
import { getDocumentBodyText } from "../officeClient.js";

function hasWordApi14() {
  return globalThis.Office?.context?.requirements?.isSetSupported?.("WordApi", "1.4") ?? false;
}

export function editStatusLabel(error) {
  if (!error) return "";
  if (error === "not_found") return " ⚠ tidak ditemukan";
  if (error === "ambiguous") return " ✖ ambigu, dilewati";
  if (error === "unanchorable") return " ⚠ tidak bisa dijangkarkan di Word, dilewati";
  if (error === "substantive") return " ✖ mengubah isi, bukan perbaikan bahasa — dilewati";
  return " ✖ dilewati";
}

export function renderEditPreview({
  container, edits, addBubble,
  expectedRevision, readBody = getDocumentBodyText, onApplied
}) {
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
    const status = editStatusLabel(item.error);
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
  let stale = false;
  const refreshLabel = () => {
    if (applying || stale) return;
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
      const gate = await applyIfCurrent({
        expectedRevision, readBody, apply: () => applyTrackedEdits(chosen)
      });
      if (gate.stale) {
        // Refuse a stale preview for good; a new proposal is required.
        stale = true;
        apply.textContent = "Usulan kedaluwarsa";
        addBubble("error", STALE_PREVIEW_MESSAGE);
        return;
      }
      const results = gate.results;
      await onApplied?.(results.filter((r) => r.status === "applied").map((r) => r.edit));
      const lines = results.map((r) =>
        r.status === "applied" ? `✔ diterapkan: "${r.edit.find}"`
          : r.status === "not_found" ? `⚠ tidak ditemukan: "${r.edit.find}"`
            : `✖ dilewati (ambigu): "${r.edit.find}"`);
      addBubble("assistant", lines.join("\n"));
    } catch (error) {
      addBubble("error", String(error?.message ?? error));
    } finally {
      applying = false;
      if (!stale) rows.forEach(({ checkbox, originalDisabled }) => { checkbox.disabled = originalDisabled; });
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
        // Same locate + anchor plan the preview used (resolveEditAnchor),
        // so a span the preview offered is the span reached here — including
        // one that crosses paragraphs or exceeds Word's 255-char search limit.
        const r = resolveEditAnchor(bodyNow, edit);
        if (r.error) {
          results.push({ edit, status: r.error === "not_found" ? "not_found" : "skipped" });
          continue;
        }
        const range = await reachPlannedRange(context, doc, r.plan);
        if (!range) {
          results.push({ edit, status: "not_found" });
          continue;
        }
        range.insertText(r.plan.replace, Word.InsertLocation.replace);
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

// Resolves an anchor plan to a live Word range, or null. Never writes: the
// expanded range's text must equal the planned span before the caller may
// replace it, so a prefix that happens to hit the wrong place fails safe.
export async function reachPlannedRange(context, doc, plan) {
  const startHits = doc.body.search(escapeWordSearch(plan.start.text), { matchCase: true });
  startHits.load("items");
  const endHits = plan.end ? doc.body.search(escapeWordSearch(plan.end.text), { matchCase: true }) : null;
  endHits?.load("items");
  await context.sync();
  const start = startHits.items[plan.start.ordinal];
  const end = plan.end ? endHits.items[plan.end.ordinal] : null;
  if (!start || (plan.end && !end)) return null;
  const range = end ? start.expandTo(end) : start;
  range.load("text");
  await context.sync();
  return rangeMatchesPlan(range.text, plan) ? range : null;
}

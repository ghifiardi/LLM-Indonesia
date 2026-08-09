// Send/receive UI for the Companion workspace: send button, incoming banner,
// inbox list, confirm-replace. All workspace-derived strings are rendered via
// textContent/createTextNode only — never via raw markup injection — since
// item text/label come from another Office document and must not be
// trusted as markup.

import {
  deriveLabel,
  bannerText,
  createPoller,
  sendItem,
  deleteItem,
  fetchWorkspace,
  dismissedIds,
  usedIds
} from "./workspaceClient.js";

const FILL_LABEL_BY_HOST = {
  PowerPoint: "Pakai sebagai brief Deck Studio",
  Excel: "Pakai sebagai brief Sheet Studio",
  Word: "Tempel ke Teks/seleksi"
};

const UNREACHABLE_HINT = "Workspace tidak terjangkau.";
const OUTDATED_COMPANION_HINT = "Perbarui paket Companion";

export function needsConfirm(existing, incoming) {
  return Boolean(existing.trim()) && existing !== incoming;
}

function fillLabelForHost(host) {
  return FILL_LABEL_BY_HOST[host] || FILL_LABEL_BY_HOST.Word;
}

function formatTime(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function mountWorkspace({ host, sourceTextEl, statusEl, doc = document, onContext }) {
  const sendBtn = doc.querySelector("#workspace-send");
  const bannerEl = doc.querySelector("#workspace-banner");
  const inboxListEl = doc.querySelector("#workspace-inbox-list");

  let items = [];
  let lastOk = true;
  let sendHint = UNREACHABLE_HINT;

  // Small status/hint line under the send button — created here rather than
  // in taskpane.html since it is purely a workspace-UI concern.
  const sendHintEl = doc.createElement("p");
  sendHintEl.id = "workspace-send-hint";
  sendHintEl.className = "hint workspace-send-hint hidden";
  sendBtn?.insertAdjacentElement?.("afterend", sendHintEl);

  function setStatus(message) {
    if (statusEl) statusEl.textContent = message;
  }

  function newestFirst() {
    // Server appends newest last; reverse so index 0 is the most recent.
    return items.slice().reverse();
  }

  function updateSendButtonState() {
    if (!sendBtn) return;
    sendBtn.disabled = !lastOk;
    sendHintEl.textContent = lastOk ? "" : sendHint;
    sendHintEl.classList.toggle("hidden", lastOk);
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function applyFill(item) {
    sourceTextEl.value = item.text;
    usedIds.add(item.id);
    renderAll();
  }

  // Builds the small action-button cluster used by both the banner and each
  // inbox row: a host-worded "Pakai ..." button that, when the target box
  // already holds different text, swaps itself for an inline confirm strip
  // instead of overwriting silently.
  function buildFillControls(item, { withDismiss }) {
    const wrap = doc.createElement("div");
    wrap.className = "workspace-actions";

    function renderDefault() {
      clearNode(wrap);
      const fillBtn = doc.createElement("button");
      fillBtn.type = "button";
      fillBtn.className = "secondary small";
      fillBtn.textContent = fillLabelForHost(host);
      fillBtn.addEventListener("click", () => {
        const existing = sourceTextEl.value || "";
        if (needsConfirm(existing, item.text)) {
          renderConfirm();
        } else {
          applyFill(item);
        }
      });
      wrap.appendChild(fillBtn);

      if (withDismiss) {
        const dismissBtn = doc.createElement("button");
        dismissBtn.type = "button";
        dismissBtn.className = "link";
        dismissBtn.textContent = "Abaikan";
        dismissBtn.addEventListener("click", () => {
          dismissedIds.add(item.id);
          renderAll();
        });
        wrap.appendChild(dismissBtn);
      }
    }

    function renderConfirm() {
      clearNode(wrap);
      const msg = doc.createElement("span");
      msg.className = "workspace-confirm-text";
      msg.textContent = "Kotak tujuan sudah berisi teks — ganti?";
      wrap.appendChild(msg);

      const gantiBtn = doc.createElement("button");
      gantiBtn.type = "button";
      gantiBtn.className = "secondary small";
      gantiBtn.textContent = "Ganti";
      gantiBtn.addEventListener("click", () => applyFill(item));
      wrap.appendChild(gantiBtn);

      const batalBtn = doc.createElement("button");
      batalBtn.type = "button";
      batalBtn.className = "link";
      batalBtn.textContent = "Batal";
      batalBtn.addEventListener("click", renderDefault);
      wrap.appendChild(batalBtn);
    }

    renderDefault();
    return wrap;
  }

  function renderBanner() {
    if (!bannerEl) return;
    clearNode(bannerEl);
    const item = newestFirst().find(
      (it) => it.source_host !== host && !dismissedIds.has(it.id) && !usedIds.has(it.id)
    );
    if (!item) {
      bannerEl.classList.add("hidden");
      return;
    }
    bannerEl.classList.remove("hidden");

    const textEl = doc.createElement("p");
    textEl.className = "workspace-banner-text";
    textEl.textContent = bannerText(item);
    bannerEl.appendChild(textEl);

    bannerEl.appendChild(buildFillControls(item, { withDismiss: true }));
  }

  function renderInbox() {
    if (!inboxListEl) return;
    clearNode(inboxListEl);
    const ordered = newestFirst();
    if (ordered.length === 0) {
      const empty = doc.createElement("p");
      empty.className = "hint";
      empty.textContent = "Belum ada kiriman.";
      inboxListEl.appendChild(empty);
      return;
    }

    ordered.forEach((item) => {
      const row = doc.createElement("div");
      row.className = "workspace-inbox-row";

      const label = doc.createElement("span");
      label.className = "workspace-inbox-label";
      label.textContent = `[${item.source_host}] ${item.label} · ${formatTime(item.created_at)}`;
      row.appendChild(label);

      row.appendChild(buildFillControls(item, { withDismiss: false }));

      if (usedIds.has(item.id)) {
        const check = doc.createElement("span");
        check.className = "workspace-used-check";
        check.textContent = "✓";
        row.appendChild(check);
      }

      const deleteBtn = doc.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "link";
      deleteBtn.textContent = "Hapus";
      deleteBtn.addEventListener("click", async () => {
        await deleteItem(item.id);
        poller.pollNow();
      });
      row.appendChild(deleteBtn);

      inboxListEl.appendChild(row);
    });
  }

  function renderAll() {
    renderBanner();
    renderInbox();
  }

  async function fetchWrapped(sinceRev) {
    const result = await fetchWorkspace(sinceRev);
    if (result.status === 404) {
      lastOk = false;
      sendHint = OUTDATED_COMPANION_HINT;
      updateSendButtonState();
      // Treated exactly like "no update" so the poller keeps its normal
      // schedule rather than backing off forever on a permanent 404.
      return { status: 304 };
    }
    return result;
  }

  const poller = createPoller({
    fetchFn: fetchWrapped,
    onUpdate: (body) => {
      lastOk = true;
      sendHint = UNREACHABLE_HINT;
      items = Array.isArray(body.items) ? body.items : [];
      updateSendButtonState();
      renderAll();
      onContext?.(body.context);
    },
    onError: () => {
      lastOk = false;
      sendHint = UNREACHABLE_HINT;
      updateSendButtonState();
    },
    isVisible: () => doc.visibilityState !== "hidden"
  });

  sendBtn?.addEventListener("click", async () => {
    const text = (sourceTextEl.value || "").trim();
    if (!text) {
      setStatus("Isi teks/seleksi dulu sebelum mengirim.");
      return;
    }
    const kind = host === "Excel" ? "range" : "selection";
    const label = deriveLabel(text);
    try {
      const { status } = await sendItem({ source_host: host, kind, label, text });
      if (status === 404) {
        lastOk = false;
        sendHint = OUTDATED_COMPANION_HINT;
        updateSendButtonState();
        setStatus(`Gagal mengirim: ${OUTDATED_COMPANION_HINT}`);
        return;
      }
      if (status < 200 || status >= 300) {
        setStatus("Gagal mengirim ke workspace.");
        return;
      }
      poller.pollNow();
      setStatus("Terkirim ke workspace ✓");
    } catch {
      lastOk = false;
      sendHint = UNREACHABLE_HINT;
      updateSendButtonState();
      setStatus("Gagal mengirim: workspace tidak terjangkau.");
    }
  });

  updateSendButtonState();
  renderAll();
  poller.start();

  return { refresh: poller.pollNow, stop: poller.stop };
}

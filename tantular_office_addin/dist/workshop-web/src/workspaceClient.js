// Pane-side client for the Companion workspace: pure builders, a
// visibility-gated since_rev poll scheduler, and thin fetch wrappers over
// the /api/workspace* HTTP surface (Tasks 1-2). No UI here (see Task 4).

import { companionUrl } from "./companionUrl.js";

const DISMISSED_KEY = "tantular.workspace.dismissed.v1";
const USED_KEY = "tantular.workspace.used.v1";
const MAX_IDS = 50;

// ---------------------------------------------------------------------------
// Pure builders
// ---------------------------------------------------------------------------

export function deriveLabel(text) {
  const raw = String(text || "");
  const headingMatch = raw.match(/^\s*#{1,6}\s+(.+)$/m);
  let label;
  if (headingMatch) {
    label = headingMatch[1].trim();
  } else {
    const words = raw.trim().split(/\s+/).filter(Boolean);
    label = words.slice(0, 8).join(" ");
  }
  return label.slice(0, 120);
}

export function wordCount(text) {
  const raw = String(text || "").trim();
  if (!raw) return 0;
  return raw.split(/\s+/).filter(Boolean).length;
}

export function bannerText(item) {
  const sourceHost = item?.source_host ?? "";
  const label = item?.label ?? "";
  const n = wordCount(item?.text ?? "");
  return `Konten masuk dari ${sourceHost}: "${label}" · ${n} kata`;
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

export function createPoller({
  fetchFn,
  onUpdate,
  onError,
  intervalMs = 4000,
  backoffMs = 30000,
  isVisible = () => true,
  scheduleFn = (fn, ms) => setTimeout(fn, ms),
  cancelFn = (id) => clearTimeout(id)
} = {}) {
  let sinceRev = 0;
  let timerId = null;
  let nextDelay = intervalMs;
  let isFetching = false;

  // pollNow always (re)schedules the next tick after it settles, whether
  // invoked by the internal timer loop or called directly (e.g. by tests
  // or a manual "poll now" action) — this is what makes the failure ->
  // backoff -> success -> normal-interval sequence observable one call at
  // a time, and lets a hidden pane keep its schedule alive to resume once
  // visible again.
  async function pollNow() {
    if (isFetching) {
      return;
    }
    if (!isVisible()) {
      scheduleNext();
      return;
    }
    try {
      isFetching = true;
      const { status, body } = await fetchFn(sinceRev);
      if (status === 200 && body) {
        sinceRev = body.rev;
        onUpdate?.(body);
      }
      nextDelay = intervalMs;
    } catch (err) {
      nextDelay = backoffMs;
      onError?.(err);
    } finally {
      isFetching = false;
      scheduleNext();
    }
  }

  function scheduleNext() {
    if (timerId !== null) {
      cancelFn(timerId);
    }
    timerId = scheduleFn(() => pollNow(), nextDelay);
  }

  function start() {
    nextDelay = intervalMs;
    scheduleNext();
  }

  function stop() {
    if (timerId !== null) {
      cancelFn(timerId);
      timerId = null;
    }
  }

  return { start, stop, pollNow };
}

// ---------------------------------------------------------------------------
// Fetch wrappers — resolve {status, body} without throwing on non-2xx.
// Network errors (fetch itself rejecting) propagate as rejections.
// ---------------------------------------------------------------------------

async function readJsonBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchWorkspace(sinceRev) {
  const qs = sinceRev ? `?since_rev=${encodeURIComponent(sinceRev)}` : "";
  const response = await fetch(companionUrl(`/api/workspace${qs}`), {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  return { status: response.status, body: await readJsonBody(response) };
}

export async function sendItem({ source_host, kind, label, text }) {
  const response = await fetch(companionUrl("/api/workspace/items"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_host, kind, label, text })
  });
  return { status: response.status, body: await readJsonBody(response) };
}

export async function deleteItem(id) {
  const response = await fetch(companionUrl(`/api/workspace/items/${encodeURIComponent(id)}`), {
    method: "DELETE"
  });
  return { status: response.status, body: await readJsonBody(response) };
}

export async function putContext({ instructions, source_host }) {
  const response = await fetch(companionUrl("/api/workspace/context"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instructions, source_host })
  });
  return { status: response.status, body: await readJsonBody(response) };
}

// ---------------------------------------------------------------------------
// localStorage-backed id sets (dismissed / used), bounded FIFO of 50 ids.
// Must never crash in a Node test context (no localStorage global).
// ---------------------------------------------------------------------------

function safeLocalStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function loadIds(key) {
  const ls = safeLocalStorage();
  if (!ls) return [];
  try {
    const parsed = JSON.parse(ls.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveIds(key, ids) {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(key, JSON.stringify(ids));
  } catch {
    // ignore quota / access errors
  }
}

function makeIdSet(key) {
  return {
    add(id) {
      const value = String(id);
      let ids = loadIds(key).filter((existing) => existing !== value);
      ids.push(value);
      if (ids.length > MAX_IDS) {
        ids = ids.slice(ids.length - MAX_IDS);
      }
      saveIds(key, ids);
    },
    has(id) {
      return loadIds(key).includes(String(id));
    },
    list() {
      return loadIds(key);
    }
  };
}

export const dismissedIds = makeIdSet(DISMISSED_KEY);
export const usedIds = makeIdSet(USED_KEY);

// ---------------------------------------------------------------------------
// Consumed by Task 5: adopt server-authoritative context when it changed.
// ---------------------------------------------------------------------------

export function shouldAdoptServerContext(serverContext, lastAppliedUpdatedAt) {
  const updatedAt = serverContext?.updated_at;
  if (!updatedAt) return false;
  return updatedAt !== lastAppliedUpdatedAt;
}

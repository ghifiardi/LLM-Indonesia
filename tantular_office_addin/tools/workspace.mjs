import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HOSTS = new Set(["Word", "Excel", "PowerPoint"]);
const KINDS = new Set(["selection", "document", "range", "outline"]);
const MAX_ITEMS = 10;
const MAX_TEXT = 60000;
const MAX_INSTRUCTIONS = 8000;
const MAX_LABEL = 120;

export function createWorkspaceStore({ filePath }) {
  let state = load(filePath);

  function persist() {
    const tmp = `${filePath}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, filePath);
  }

  return {
    get rev() { return state.rev; },
    snapshot() { return structuredClone(state); },
    addItem(input) {
      const err = validateItem(input);
      if (err) return { ok: false, error: err };
      const item = {
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        source_host: input.source_host,
        kind: input.kind,
        label: String(input.label ?? "").slice(0, MAX_LABEL),
        text: input.text
      };
      state.items.push(item);
      if (state.items.length > MAX_ITEMS) state.items.shift();
      state.rev += 1;
      persist();
      return { ok: true, item };
    },
    deleteItem(id) {
      const before = state.items.length;
      state.items = state.items.filter((it) => it.id !== id);
      if (state.items.length === before) return { ok: false };
      state.rev += 1;
      persist();
      return { ok: true };
    },
    setContext({ instructions, source_host }) {
      if (!HOSTS.has(source_host)) return { ok: false, error: "source_host tidak dikenal." };
      const value = String(instructions ?? "");
      if (value.length > MAX_INSTRUCTIONS) return { ok: false, error: `Instruksi melebihi ${MAX_INSTRUCTIONS} karakter.` };
      if (value === state.context.instructions) return { ok: true, context: structuredClone(state.context), changed: false };
      state.context = { instructions: value, updated_at: new Date().toISOString(), updated_by: source_host };
      state.rev += 1;
      persist();
      return { ok: true, context: structuredClone(state.context), changed: true };
    }
  };
}

function validateItem(input) {
  if (!HOSTS.has(input?.source_host)) return "source_host tidak dikenal.";
  if (!KINDS.has(input?.kind)) return "kind tidak dikenal.";
  const text = String(input?.text ?? "");
  if (!text.trim()) return "text kosong.";
  if (text.length > MAX_TEXT) return `text melebihi ${MAX_TEXT} karakter.`;
  return null;
}

function emptyState() {
  return { rev: 0, items: [], context: { instructions: "", updated_at: null, updated_by: null } };
}

function load(filePath) {
  try {
    if (!fs.existsSync(filePath)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (typeof parsed?.rev !== "number" || !Array.isArray(parsed?.items) || typeof parsed?.context !== "object") {
      throw new Error("bentuk tidak valid");
    }
    return parsed;
  } catch {
    try { fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`); } catch {}
    console.warn(`[workspace] file rusak dikarantina; mulai kosong: ${filePath}`);
    return emptyState();
  }
}

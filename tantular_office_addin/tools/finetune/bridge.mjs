// Long-lived stdin/stdout JSONL worker exposing the add-in's REAL prompt
// registry and edit validators to the Python fine-tuning harness. One JSON
// request per stdin line, one JSON response per stdout line. Never
// reimplements prompt content or edit-validation logic — always imports the
// production modules directly, so the harness sees exactly what the add-in
// runs.
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { allPromptIds, getPrompt } from "../../src/promptRegistry.js";
import { parseEditContract, resolveEdits } from "../../src/chat/editContract.js";
import { applyEditsToText } from "../../src/chat/applyEdits.js";

const PROTOCOL_VERSION = "1";

function resolveJsCommit() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handleDumpPrompts() {
  return allPromptIds().map((pid) => getPrompt(pid));
}

function handleValidateEdit(args) {
  const docText = args?.docText;
  const out = { parse: { ok: true }, resolve: [], apply: null };

  let edits;
  try {
    edits = parseEditContract(JSON.stringify({ edits: args?.edits })).edits;
  } catch (e) {
    out.parse = { ok: false, error: String(e?.message ?? e) };
    return out;
  }

  out.resolve = resolveEdits(docText, edits).map((r) =>
    r.error ? { error: r.error } : { index: r.index, length: r.length }
  );
  out.apply = applyEditsToText(docText, edits);
  return out;
}

function dispatch(cmd, args) {
  if (cmd === "dump-prompts") return handleDumpPrompts();
  if (cmd === "validate-edit") return handleValidateEdit(args);
  throw new Error(`unknown cmd: ${cmd}`);
}

function main() {
  writeLine({ type: "ready", protocol_version: PROTOCOL_VERSION, js_commit: resolveJsCommit() });

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    if (!line.trim()) return;

    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      // Malformed JSON: no id is recoverable, but the protocol still owes the
      // caller an explicit error line — never crash, never go silent.
      writeLine({ id: null, ok: false, error: `malformed request JSON: ${String(e?.message ?? e)}` });
      return;
    }

    const { id, cmd, args } = req ?? {};
    try {
      const result = dispatch(cmd, args);
      writeLine({ id, ok: true, result });
    } catch (e) {
      writeLine({ id, ok: false, error: String(e?.message ?? e) });
    }
  });

  rl.on("close", () => process.exit(0));
}

main();

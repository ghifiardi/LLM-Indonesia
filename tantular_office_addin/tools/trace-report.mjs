// Reads the demo trace back as video timecodes.
//
// Prints the last recorded session (or --all sessions) as mm:ss offsets from
// the moment capture started, so a line that looks wrong here names the second
// to scrub to in the video.
//
// Usage:  node tools/trace-report.mjs [--all] [--errors]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tracePath = process.env.TANTULAR_TRACE_FILE || path.join(os.homedir(), ".tantular-trace.ndjson");
const wantAll = process.argv.includes("--all");
const errorsOnly = process.argv.includes("--errors");

if (!fs.existsSync(tracePath)) {
  console.error(`Belum ada trace di ${tracePath}. Jalankan Companion dengan TANTULAR_TRACE=1.`);
  process.exit(1);
}

const entries = fs.readFileSync(tracePath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter(Boolean);

const starts = entries.map((entry, index) => ({ entry, index })).filter((item) => item.entry.kind === "session_start");
if (!starts.length) {
  console.error("Belum ada sesi rekaman dalam trace ini.");
  process.exit(1);
}

const timecode = (ms) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

const isError = (entry) =>
  entry.level === "error" || entry.level === "warn" || (typeof entry.status === "number" && entry.status >= 400);

for (const start of wantAll ? starts : starts.slice(-1)) {
  const t0 = Date.parse(start.entry.t);
  const end = entries.findIndex((entry, index) => index > start.index && entry.kind === "session_end");
  const slice = entries.slice(start.index + 1, end === -1 ? entries.length : end);

  console.log(`\n=== ${start.entry.name}  (${start.entry.t}) ===`);
  console.log(`video: ${start.entry.video}\n`);

  let shown = 0;
  for (const entry of slice) {
    if (errorsOnly && !isError(entry)) continue;
    const at = timecode(Date.parse(entry.t) - t0);
    if (entry.kind === "http") {
      const flag = entry.status >= 400 ? " <-- " : "     ";
      console.log(`${at}${flag}${String(entry.status).padEnd(4)} ${entry.method.padEnd(5)} ${entry.path}  ${entry.ms}ms`);
    } else if (entry.kind === "pane") {
      const flag = entry.level === "error" ? " <-- " : "     ";
      console.log(`${at}${flag}[${entry.level}] ${entry.text}`);
    }
    shown += 1;
  }
  if (!shown) console.log("(tidak ada entri)");
}

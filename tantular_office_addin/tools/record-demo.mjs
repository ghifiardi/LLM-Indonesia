// Records a Tantular demo and pairs the video with the companion's trace.
//
// The video shows what the presenter saw; the trace shows what the pane and
// the companion actually did. Both are useless apart when something goes
// wrong mid-demo, so this writes a session_start marker into the trace at the
// exact moment capture begins — every later entry's offset from it is the
// timecode to scrub to.
//
// Usage:  npm run record -- [name]     stop with q
// The companion must already be running with TANTULAR_TRACE=1.

import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const name = (process.argv[2] || "demo").replace(/[^A-Za-z0-9._-]/g, "-");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = process.env.RECORD_DIR || path.join(os.homedir(), "Desktop", "tantular-demos");
const video = path.join(outDir, `${name}-${stamp}.mp4`);
const tracePath = process.env.TANTULAR_TRACE_FILE || path.join(os.homedir(), ".tantular-trace.ndjson");
const port = process.env.PORT || 3000;

// avfoundation indices; list them with:
//   ffmpeg -f avfoundation -list_devices true -i ""
const videoDev = process.env.VIDEO_DEV || "2";   // Capture screen 0
const audioDev = process.env.AUDIO_DEV || "0";   // built-in microphone; "none" to mute

function probeCompanion() {
  return new Promise((resolve) => {
    const req = https.request(
      { host: "localhost", port, path: "/api/__trace", method: "GET", rejectUnauthorized: false, timeout: 2000 },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try { resolve(JSON.parse(body)?.on === true); } catch { resolve(false); }
        });
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function appendTrace(entry) {
  fs.appendFileSync(tracePath, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
}

const traceOn = await probeCompanion();
if (!traceOn) {
  console.warn("");
  console.warn("========================================================================");
  console.warn("TRACE MATI — rekaman akan jalan, tapi tanpa transkrip yang bisa dibaca.");
  console.warn("");
  console.warn("Jalankan ulang Companion dengan:  TANTULAR_TRACE=1 npm start");
  console.warn("(lalu buka kembali panel Tantular di Office)");
  console.warn("========================================================================");
  console.warn("");
}

fs.mkdirSync(outDir, { recursive: true });
appendTrace({ kind: "session_start", name, video });

const input = audioDev === "none" ? videoDev : `${videoDev}:${audioDev}`;
const args = [
  "-hide_banner", "-loglevel", "warning",
  "-f", "avfoundation", "-capture_cursor", "1", "-capture_mouse_clicks", "1",
  "-framerate", "30", "-i", input,
  "-c:v", "h264_videotoolbox", "-b:v", "6M", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "128k",
  "-movflags", "+faststart",
  video
];

console.log(`Merekam  -> ${video}`);
console.log(`Trace    -> ${tracePath}${traceOn ? "" : "  (mati)"}`);
console.log("Tekan q di jendela ini untuk berhenti.\n");

const ffmpeg = spawn("ffmpeg", args, { stdio: "inherit" });

ffmpeg.on("error", (error) => {
  console.error(`ffmpeg gagal dijalankan: ${error.message}`);
  console.error("Pasang dengan:  brew install ffmpeg");
  process.exit(1);
});

ffmpeg.on("close", (code) => {
  appendTrace({ kind: "session_end", name, video });
  console.log("");
  console.log(`Video : ${video}`);
  console.log(`Laporan: node tools/trace-report.mjs`);
  process.exit(code === null ? 0 : code);
});

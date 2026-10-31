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
import { execFileSync, spawn } from "node:child_process";

const name = (process.argv[2] || "demo").replace(/[^A-Za-z0-9._-]/g, "-");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = process.env.RECORD_DIR || path.join(os.homedir(), "Desktop", "tantular-demos");
const video = path.join(outDir, `${name}-${stamp}.mp4`);
const tracePath = process.env.TANTULAR_TRACE_FILE || path.join(os.homedir(), ".tantular-trace.ndjson");
const port = process.env.PORT || 3000;

// avfoundation devices are resolved by NAME, never by a hardcoded index: the
// indices shift the moment a Continuity Camera or Desk View appears, and an
// index that points at the wrong device does not fail loudly — it records the
// webcam. VIDEO_DEV / AUDIO_DEV still override with an explicit index.
function listDevices() {
  let output = "";
  try {
    execFileSync("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    // Listing always exits non-zero: the empty input is what makes it print.
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  const video = [];
  const audio = [];
  let bucket = null;
  for (const line of output.split("\n")) {
    if (line.includes("AVFoundation video devices")) { bucket = video; continue; }
    if (line.includes("AVFoundation audio devices")) { bucket = audio; continue; }
    const match = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (bucket && match) bucket.push({ index: match[1], name: match[2] });
  }
  return { video, audio };
}

const devices = listDevices();
const screen = devices.video.find((device) => /^Capture screen/i.test(device.name));
const microphone = devices.audio.find((device) => /microphone|built-in/i.test(device.name)) || devices.audio[0];

if (!process.env.VIDEO_DEV && !screen) {
  console.error("Tidak menemukan perangkat 'Capture screen' pada ffmpeg avfoundation.");
  console.error("Periksa izin Screen Recording untuk Terminal, lalu:");
  console.error('  ffmpeg -f avfoundation -list_devices true -i ""');
  process.exit(1);
}

const videoDev = process.env.VIDEO_DEV || screen.index;
const videoName = process.env.VIDEO_DEV ? `index ${process.env.VIDEO_DEV}` : screen.name;
const audioDev = process.env.AUDIO_DEV || (microphone ? microphone.index : "none");
const audioName = audioDev === "none" ? "(bisu)" : (process.env.AUDIO_DEV ? `index ${audioDev}` : microphone.name);

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

// No input -framerate and no output -r: the screen device supplies its own
// timestamps, and forcing a rate makes ffmpeg duplicate frames by the million
// ("frame duplication too large"). The capture runs at the display's rate.
//
// The noisy warnings avfoundation prints here — a failed device configuration,
// an unsupported pixel format — are benign for screen capture: a 3s control
// capture with these exact arguments produced 3024x1964, the full display. The
// honest check is the recorded frame size, verified after the fact below.
const input = audioDev === "none" ? videoDev : `${videoDev}:${audioDev}`;
const args = [
  "-hide_banner", "-loglevel", "warning",
  "-f", "avfoundation", "-capture_cursor", "1", "-capture_mouse_clicks", "1",
  "-i", input,
  "-c:v", "h264_videotoolbox", "-b:v", "6M", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "128k",
  "-movflags", "+faststart",
  video
];

console.log(`Merekam  -> ${video}`);
console.log(`Sumber   -> ${videoName} + ${audioName}`);
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
  verify(video);
  console.log(`Laporan: node tools/trace-report.mjs`);
  process.exit(code === null ? 0 : code);
});

// What actually got recorded, checked rather than assumed. A screen capture is
// the size of the display; a webcam is not. Saying so out loud costs one line
// and settles the question before a demo is trusted.
function displaySize() {
  try {
    const out = execFileSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8" });
    const match = out.match(/Resolution:\s*(\d+)\s*x\s*(\d+)/);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  } catch {
    return null;
  }
}

function verify(file) {
  let width, height, duration;
  try {
    const out = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1", file
    ], { encoding: "utf8" }).trim().split("\n");
    [width, height, duration] = [Number(out[0]), Number(out[1]), Number(out[2])];
  } catch {
    console.log("Ukuran : tidak bisa dibaca (ffprobe gagal).");
    return;
  }

  const display = displaySize();
  const matchesDisplay = display && width === display.width && height === display.height;
  console.log(`Ukuran : ${width}x${height}, ${Math.round(duration || 0)} detik${matchesDisplay ? "  (sesuai layar)" : ""}`);

  if (display && !matchesDisplay) {
    console.warn("");
    console.warn("========================================================================");
    console.warn(`PERIKSA REKAMAN: ukurannya ${width}x${height}, sedangkan layar ${display.width}x${display.height}.`);
    console.warn("Kemungkinan yang terekam bukan layar (mis. kamera). Periksa dengan:");
    console.warn('  ffmpeg -f avfoundation -list_devices true -i ""');
    console.warn("lalu jalankan ulang:  VIDEO_DEV=<indeks layar> npm run record -- nama");
    console.warn("========================================================================");
  }
}

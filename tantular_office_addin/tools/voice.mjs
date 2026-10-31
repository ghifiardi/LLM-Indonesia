// Local push-to-talk voice for the Word chat: speech-to-text with whisper.cpp
// and text-to-speech with macOS `say`, both run as child processes on THIS
// machine. Nothing here opens a network connection — audio arrives over the
// loopback socket from the task pane, is written to a private temp dir,
// transcribed, and deleted. The dev server only mounts these routes for
// loopback peers (see isLoopbackAddress) so a LAN client can never use the
// Mac's microphone pipeline or speakers.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const VOICE_LANGUAGES = Object.freeze(["id", "en"]);
export const MAX_VOICE_AUDIO_BYTES = 4 * 1024 * 1024; // ~2 min of 16 kHz mono PCM
const MAX_SPEAK_CHARS = 4000;
const DEFAULT_VOICES = Object.freeze({ id: "Damayanti", en: "Samantha" });

export function voiceConfig(env = process.env, root = process.cwd()) {
  return {
    whisperBin: env.TANTULAR_WHISPER_BIN || firstExisting(["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]) || "whisper-cli",
    // The repo keeps the multilingual base model beside the distillation
    // agent service; a packaged companion points TANTULAR_WHISPER_MODEL at
    // its own copy.
    whisperModel: env.TANTULAR_WHISPER_MODEL
      || path.resolve(root, "..", "tantular-distillation", "agent_service", "voice-models", "ggml-base.bin"),
    sayBin: env.TANTULAR_SAY_BIN || "/usr/bin/say",
    recorderBin: env.TANTULAR_VOICE_RECORDER_BIN || firstExisting(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) || "",
    recorderInput: env.TANTULAR_VOICE_INPUT || ":default",
    voices: {
      id: env.TANTULAR_VOICE_ID || DEFAULT_VOICES.id,
      en: env.TANTULAR_VOICE_EN || DEFAULT_VOICES.en
    },
    timeoutMs: Number(env.TANTULAR_WHISPER_TIMEOUT_MS || 60_000)
  };
}

function firstExisting(paths) {
  return paths.find((candidate) => fs.existsSync(candidate)) || "";
}

export function isLoopbackAddress(address) {
  const value = String(address || "").toLowerCase();
  return value === "::1" || value === "127.0.0.1" || value.startsWith("127.") || value === "::ffff:127.0.0.1";
}

// "auto" lets whisper pick, but only Indonesian and English are supported
// answers. Anything else is coerced, never passed through.
export function normalizeLanguage(value) {
  const lang = String(value || "").trim().toLowerCase();
  return VOICE_LANGUAGES.includes(lang) ? lang : "auto";
}

// Whisper's base model regularly labels Indonesian speech as Malay; the two are
// close enough that "ms" is treated as Indonesian. Any other detection is not a
// supported language for this feature.
export function supportedDetectedLanguage(detected) {
  const lang = String(detected || "").trim().toLowerCase();
  if (lang === "id" || lang === "ms") return "id";
  if (lang === "en") return "en";
  return null;
}

export function parseWhisperJson(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  const text = (Array.isArray(data?.transcription) ? data.transcription : [])
    .map((segment) => String(segment?.text || ""))
    .join(" ");
  return { text: cleanTranscript(text), detected: String(data?.result?.language || "") };
}

// Whisper emits bracketed non-speech tags ("[BLANK_AUDIO]", "(music)") for
// silence; those must never be sent to the chat as if the user said them.
export function cleanTranscript(text) {
  return String(text || "")
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeWav(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 44
    && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE";
}

function runProcess(bin, args, { timeoutMs = 60_000, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} gagal (${signal || code}): ${stderr.slice(-300).trim()}`));
    });
    if (input !== null) child.stdin.end(input);
  });
}

async function whisperOnce(config, wavPath, outBase, language) {
  await runProcess(config.whisperBin, [
    "-m", config.whisperModel,
    "-l", language,
    "-nt", "-np",
    "-oj", "-of", outBase,
    "-f", wavPath
  ], { timeoutMs: config.timeoutMs });
  return parseWhisperJson(fs.readFileSync(`${outBase}.json`, "utf8"));
}

export async function transcribeWav(config, wavBuffer, requestedLanguage = "auto") {
  if (!looksLikeWav(wavBuffer)) throw Object.assign(new Error("Audio harus berupa WAV."), { status: 400 });
  if (!fs.existsSync(config.whisperModel)) {
    throw Object.assign(new Error(`Model Whisper tidak ditemukan: ${config.whisperModel}`), { status: 503 });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tantular-voice-"));
  try {
    const wavPath = path.join(dir, "input.wav");
    fs.writeFileSync(wavPath, wavBuffer, { mode: 0o600 });
    const language = normalizeLanguage(requestedLanguage);
    let result = await whisperOnce(config, wavPath, path.join(dir, "out"), language);
    let resolved = language === "auto" ? supportedDetectedLanguage(result.detected) : language;
    if (!resolved) {
      // Auto-detect landed on an unsupported language: decode again as
      // Indonesian (the product's primary language) instead of returning text
      // in, say, Javanese transliteration.
      result = await whisperOnce(config, wavPath, path.join(dir, "out-id"), "id");
      resolved = "id";
    }
    return { text: result.text, language: resolved };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Voices are probed once per process; `say -v ?` lists what is installed
// locally. A voice that is listed but whose data is missing still fails at
// speak time, which surfaces as an error instead of silence.
let installedVoicesPromise = null;
export function installedVoices(config) {
  if (!installedVoicesPromise) {
    installedVoicesPromise = runProcess(config.sayBin, ["-v", "?"], { timeoutMs: 10_000 })
      .then(({ stdout }) => stdout.split("\n").map((line) => line.trim()).filter(Boolean))
      .catch(() => []);
  }
  return installedVoicesPromise;
}

export function resetVoiceCache() {
  installedVoicesPromise = null;
}

export function voiceListed(lines, voice) {
  const name = String(voice || "").toLowerCase();
  return lines.some((line) => line.toLowerCase().startsWith(`${name} `) || line.toLowerCase().startsWith(`${name}(`));
}

let currentSpeech = null;

export function stopSpeaking() {
  const speech = currentSpeech;
  currentSpeech = null;
  if (!speech) return false;
  speech.kill("SIGTERM");
  return true;
}

// Resolves when playback ends: { completed: true } for a natural finish,
// { completed: false } when stopped. Text goes through stdin, never argv, so a
// reply that starts with "-" can never be parsed as a `say` option.
export function speakText(config, text, language) {
  const lang = VOICE_LANGUAGES.includes(language) ? language : "id";
  const spoken = String(text || "").slice(0, MAX_SPEAK_CHARS).trim();
  if (!spoken) return Promise.resolve({ completed: true, voice: config.voices[lang] });
  stopSpeaking();
  return new Promise((resolve, reject) => {
    const child = spawn(config.sayBin, ["-v", config.voices[lang]], { stdio: ["pipe", "ignore", "pipe"] });
    currentSpeech = child;
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (currentSpeech === child) currentSpeech = null;
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (currentSpeech === child) currentSpeech = null;
      if (code === 0) resolve({ completed: true, voice: config.voices[lang] });
      else if (signal) resolve({ completed: false, voice: config.voices[lang] });
      else reject(new Error(`Suara "${config.voices[lang]}" gagal: ${stderr.slice(-200).trim() || `kode ${code}`}`));
    });
    child.stdin.end(spoken);
  });
}

// Fallback capture for webviews that refuse getUserMedia: ffmpeg records the
// Mac's default input device to a temp WAV until stopped. One recording at a
// time; the microphone permission belongs to whichever app launched the
// companion (Terminal, iTerm, …).
let currentRecording = null;

export function startRecording(config) {
  if (!config.recorderBin) {
    throw Object.assign(new Error("Perekam Companion tidak tersedia (ffmpeg tidak ditemukan)."), { status: 503 });
  }
  cancelRecording();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tantular-rec-"));
  const wavPath = path.join(dir, "input.wav");
  const child = spawn(config.recorderBin, [
    "-hide_banner", "-loglevel", "error",
    "-f", "avfoundation", "-i", config.recorderInput,
    "-t", "120", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y", wavPath
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  child.on("error", () => {});
  currentRecording = { child, dir, wavPath, exited, stderr: () => stderr };
  return { recording: true };
}

export async function finishRecording() {
  const recording = currentRecording;
  currentRecording = null;
  if (!recording) throw Object.assign(new Error("Tidak ada rekaman yang sedang berjalan."), { status: 409 });
  try {
    // "q" on stdin makes ffmpeg finalize the WAV header before exiting.
    recording.child.stdin.end("q");
    const timer = setTimeout(() => recording.child.kill("SIGKILL"), 5_000);
    await recording.exited;
    clearTimeout(timer);
    if (!fs.existsSync(recording.wavPath)) {
      throw Object.assign(new Error(`Rekaman gagal: ${recording.stderr().slice(-300).trim() || "tidak ada audio"}. Periksa izin Mikrofon untuk aplikasi yang menjalankan Companion.`), { status: 500 });
    }
    return fs.readFileSync(recording.wavPath);
  } finally {
    fs.rmSync(recording.dir, { recursive: true, force: true });
  }
}

export function cancelRecording() {
  const recording = currentRecording;
  currentRecording = null;
  if (!recording) return;
  recording.child.kill("SIGKILL");
  recording.exited.then(() => fs.rmSync(recording.dir, { recursive: true, force: true }));
}

export async function voiceStatus(config) {
  const lines = await installedVoices(config);
  return {
    ok: true,
    local: true,
    stt: {
      engine: "whisper.cpp",
      binary: fs.existsSync(config.whisperBin) || !config.whisperBin.includes("/"),
      model: fs.existsSync(config.whisperModel)
    },
    tts: {
      engine: "macOS say",
      voices: {
        id: voiceListed(lines, config.voices.id) ? config.voices.id : null,
        en: voiceListed(lines, config.voices.en) ? config.voices.en : null
      }
    },
    recorder: Boolean(config.recorderBin)
  };
}

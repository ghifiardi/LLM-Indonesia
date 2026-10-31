// Local voice service: tools/voice.mjs unit behavior, then the REAL
// dev-server.mjs routes end to end with fake whisper-cli / say binaries, so
// no microphone, model, or audio output is needed to run the suite.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  cleanTranscript,
  isLoopbackAddress,
  looksLikeWav,
  normalizeLanguage,
  parseWhisperJson,
  supportedDetectedLanguage,
  transcribeWav,
  voiceListed
} from "../tools/voice.mjs";
import { encodeWav } from "../src/chat/voiceCore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function makeFakes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tantular-voice-test-"));
  const log = path.join(dir, "calls.ndjson");
  const model = path.join(dir, "ggml-fake.bin");
  fs.writeFileSync(model, "fake");
  // Fake whisper-cli: records its argv, writes the JSON whisper would write.
  // FAKE_WHISPER_DETECT controls what "-l auto" detects.
  const whisper = path.join(dir, "whisper-cli");
  fs.writeFileSync(whisper, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const get = (flag) => args[args.indexOf(flag) + 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: "whisper", args }) + "\\n");
const lang = get("-l");
const language = lang === "auto" ? (process.env.FAKE_WHISPER_DETECT || "en") : lang;
fs.writeFileSync(get("-of") + ".json", JSON.stringify({
  result: { language },
  transcription: [{ text: " [BLANK_AUDIO] tolong ringkas" }, { text: " paragraf ini" }]
}));
`, { mode: 0o755 });
  const say = path.join(dir, "say");
  fs.writeFileSync(say, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "-v" && args[1] === "?") {
  process.stdout.write("Damayanti (Indonesian (Indonesia)) id_ID    # Halo!\\nSamantha (English (US)) en_US    # Hello!\\n");
  process.exit(0);
}
let input = "";
process.stdin.on("data", (c) => { input += c; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ bin: "say", args, input }) + "\\n");
});
`, { mode: 0o755 });
  const calls = () => fs.existsSync(log)
    ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return { dir, whisper, say, model, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const wav = () => Buffer.from(encodeWav(new Float32Array(1600), 16000));

test("transcripts are cleaned of whisper non-speech tags", () => {
  assert.equal(cleanTranscript(" [BLANK_AUDIO] (music) halo  *batuk* dunia "), "halo dunia");
  assert.deepEqual(parseWhisperJson({ result: { language: "id" }, transcription: [{ text: " Halo" }, { text: " semua." }] }),
    { text: "Halo semua.", detected: "id" });
});

test("only Indonesian and English are accepted languages", () => {
  assert.equal(normalizeLanguage("ID"), "id");
  assert.equal(normalizeLanguage("en"), "en");
  assert.equal(normalizeLanguage("fr"), "auto");
  assert.equal(normalizeLanguage("--model"), "auto");
  assert.equal(supportedDetectedLanguage("ms"), "id");
  assert.equal(supportedDetectedLanguage("jw"), null);
});

test("loopback detection covers IPv4, IPv6, and mapped addresses only", () => {
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackAddress(address), true, address);
  for (const address of ["192.168.1.5", "::ffff:10.0.0.2", "", undefined]) assert.equal(isLoopbackAddress(address), false, String(address));
});

test("voice probing matches installed voice names exactly", () => {
  const lines = ["Damayanti (Indonesian (Indonesia)) id_ID    # Halo!", "Samantha (English (US)) en_US    # Hello!"];
  assert.equal(voiceListed(lines, "Damayanti"), true);
  assert.equal(voiceListed(lines, "Sam"), false);
  assert.equal(looksLikeWav(wav()), true);
  assert.equal(looksLikeWav(Buffer.from("not audio at all, definitely not a RIFF header here")), false);
});

test("auto-detected unsupported language is re-decoded as Indonesian, temp files removed", async () => {
  const fakes = makeFakes();
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("tantular-voice-") && !fakes.dir.endsWith(name)));
  process.env.FAKE_WHISPER_DETECT = "jw";
  try {
    const result = await transcribeWav({ whisperBin: fakes.whisper, whisperModel: fakes.model, timeoutMs: 10_000 }, wav(), "auto");
    assert.deepEqual(result, { text: "tolong ringkas paragraf ini", language: "id" });
    const langs = fakes.calls().map((call) => call.args[call.args.indexOf("-l") + 1]);
    assert.deepEqual(langs, ["auto", "id"]);
    const leftovers = fs.readdirSync(os.tmpdir())
      .filter((name) => name.startsWith("tantular-voice-") && !before.has(name) && !fakes.dir.endsWith(name));
    assert.deepEqual(leftovers, [], "recordings must not outlive the request");
  } finally {
    delete process.env.FAKE_WHISPER_DETECT;
    fakes.cleanup();
  }
});

test("a missing whisper model is a clear 503, not a crash", async () => {
  await assert.rejects(
    transcribeWav({ whisperBin: "/nonexistent", whisperModel: "/nonexistent/model.bin" }, wav(), "id"),
    (error) => error.status === 503 && /Model Whisper/.test(error.message)
  );
});

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startDevServer(env) {
  const port = await findFreePort();
  // Nothing listens on this port: proves status degrades when Ollama is down.
  const ollamaPort = await findFreePort();
  const child = spawn(process.execPath, [path.join(root, "tools", "dev-server.mjs")], {
    cwd: root,
    env: { ...process.env, PORT: String(port), TANTULAR_OLLAMA_PORT: String(ollamaPort), ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`dev-server did not start: ${stdout}`)); }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/dev server: (https?):\/\/localhost:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, scheme: match[1], port: Number(match[2]) });
      }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`dev-server exited ${code}: ${stdout}`)); });
  });
}

function request(server, { method = "GET", pathname, body = null, headers = {} }) {
  const mod = server.scheme === "https" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: "127.0.0.1",
      port: server.port,
      path: pathname,
      method,
      rejectUnauthorized: false,
      headers: { ...(body ? { "Content-Length": body.length } : {}), ...headers }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("dev-server voice routes: status, transcribe, speak — all through local binaries", async () => {
  const fakes = makeFakes();
  const server = await startDevServer({
    TANTULAR_WHISPER_BIN: fakes.whisper,
    TANTULAR_WHISPER_MODEL: fakes.model,
    TANTULAR_SAY_BIN: fakes.say,
    FAKE_WHISPER_DETECT: "ms"
  });
  try {
    const status = await request(server, { pathname: "/api/voice/status" });
    assert.equal(status.status, 200);
    assert.equal(status.json.local, true);
    assert.equal(status.json.stt.model, true);
    assert.deepEqual(status.json.tts.voices, { id: "Damayanti", en: "Samantha" });
    assert.deepEqual(status.json.conversationModel, { name: "tantular-office:0.5-9b", installed: null });

    const transcribed = await request(server, {
      method: "POST", pathname: "/api/voice/transcribe?lang=auto", body: wav(), headers: { "Content-Type": "audio/wav" }
    });
    assert.equal(transcribed.status, 200);
    assert.deepEqual({ text: transcribed.json.text, language: transcribed.json.language },
      { text: "tolong ringkas paragraf ini", language: "id" });

    const rejected = await request(server, {
      method: "POST", pathname: "/api/voice/transcribe", body: Buffer.from("x".repeat(100))
    });
    assert.equal(rejected.status, 400);

    const speakBody = Buffer.from(JSON.stringify({ text: "-v Alex jangan jadi opsi", language: "en" }));
    const spoken = await request(server, {
      method: "POST", pathname: "/api/voice/speak", body: speakBody, headers: { "Content-Type": "application/json" }
    });
    assert.equal(spoken.status, 200);
    assert.equal(spoken.json.completed, true);
    const sayCall = fakes.calls().find((call) => call.bin === "say");
    assert.deepEqual(sayCall.args, ["-v", "Samantha"], "reply text must never reach argv");
    assert.equal(sayCall.input, "-v Alex jangan jadi opsi");

    const foreign = await request(server, { pathname: "/api/voice/status", headers: { Origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);
  } finally {
    server.child.kill();
    fakes.cleanup();
  }
});

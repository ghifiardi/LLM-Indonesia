// Push-to-talk for the Word chat pane. Hold the mic button (or Space/Enter on
// it), speak, release: the audio goes to the LOCAL companion for whisper.cpp
// transcription, the transcript runs through the normal chat send(), and the
// reply is shown as usual and read aloud by macOS `say`. Every hop is on this
// Mac; voiceBlockReason() is re-checked before recording AND before sending,
// so switching to Mode Cloud mid-session can never route a spoken turn out.

import { concatFloat32, downsample, encodeWav, replyLanguage, speakableText, voiceBlockReason, voiceUrl } from "./voiceCore.js";
import { isCloudSession, isPortalMode } from "../companionUrl.js";
import { loadSettings } from "../tantularClient.js";

const MIN_RECORDING_MS = 400;
const MAX_RECORDING_MS = 60_000;
const LANG_LABELS = { id: "Bahasa Indonesia", en: "English" };

export function currentVoiceBlockReason() {
  return voiceBlockReason({
    cloudSession: isCloudSession(),
    portal: isPortalMode(),
    endpoint: loadSettings().endpoint
  });
}

async function voiceFetch(pathname, options = {}, timeoutMs = 90_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(voiceUrl(pathname), { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `Layanan suara lokal gagal (${response.status}).`);
    }
    return data;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Layanan suara lokal tidak menjawab tepat waktu.");
    if (error instanceof TypeError) {
      throw new Error("Tidak dapat menghubungi Tantular Companion untuk suara. Pastikan `npm run dev` berjalan.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Browser capture: raw PCM through Web Audio, resampled to 16 kHz mono WAV —
// no codec dependency, which matters because WKWebView's MediaRecorder only
// emits AAC/MP4 and whisper.cpp reads WAV.
async function startBrowserCapture() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error("getUserMedia tidak tersedia di panel ini."), { name: "NotSupportedError" });
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  });
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  const context = new AudioCtx();
  await context.resume?.();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  processor.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(processor);
  processor.connect(context.destination);
  const release = () => {
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    context.close?.();
  };
  return {
    kind: "browser",
    async stop() {
      release();
      return new Blob([encodeWav(downsample(concatFloat32(chunks), context.sampleRate, 16000), 16000)], { type: "audio/wav" });
    },
    cancel: release
  };
}

// Fallback when the Office webview refuses the microphone: the companion
// records the Mac's default input with ffmpeg. Still local; the microphone
// permission then belongs to the app that launched the companion.
async function startCompanionCapture() {
  await voiceFetch("/api/voice/record/start", { method: "POST" }, 10_000);
  return {
    kind: "companion",
    stop: null,
    cancel: () => { voiceFetch("/api/voice/record/cancel", { method: "POST" }, 5_000).catch(() => {}); }
  };
}

export function mountVoiceControls({ card, send, isBusy, addBubble }) {
  const els = {
    row: card.querySelector("#chat-voice-row"),
    mic: card.querySelector("#chat-mic"),
    lang: card.querySelector("#chat-voice-lang"),
    speak: card.querySelector("#chat-voice-speak"),
    status: card.querySelector("#chat-voice-status")
  };
  if (!els.row || !els.mic) return null;
  els.row.classList.remove("hidden");

  const state = { capture: null, startedAt: 0, maxTimer: null, phase: "idle", service: null, preferCompanion: false, releasedEarly: false };

  const setStatus = (text, tone = "") => {
    els.status.textContent = text;
    els.status.className = `chat-voice-status ${tone}`.trim();
  };
  const setPhase = (phase) => {
    state.phase = phase;
    els.mic.dataset.phase = phase;
    els.mic.setAttribute("aria-pressed", phase === "recording" ? "true" : "false");
    els.mic.textContent = phase === "recording" ? "● Merekam… lepas untuk kirim" : "🎙 Tahan untuk bicara";
  };
  setPhase("idle");

  async function refreshStatus() {
    const blocked = currentVoiceBlockReason();
    if (blocked) {
      els.mic.disabled = true;
      setStatus(blocked, "warn");
      return;
    }
    setStatus("Memeriksa suara lokal…");
    try {
      const status = await voiceFetch("/api/voice/status", { method: "GET" }, 15_000);
      state.service = status;
      const problems = [];
      if (!status.stt?.model) problems.push("model Whisper belum ada");
      if (!status.tts?.voices?.id) problems.push("suara Indonesia (Damayanti) tidak terpasang");
      if (!status.tts?.voices?.en) problems.push("suara Inggris tidak terpasang");
      els.mic.disabled = !status.stt?.model;
      const model = status.conversationModel;
      const configured = loadSettings().model;
      const modelNote = model?.installed === null
        ? " Ollama belum berjalan."
        : model?.installed && configured !== model.name
          ? ` Model chat di Pengaturan "${configured}"; ${model.name} tersedia.`
          : model?.installed ? "" : ` ${model?.name} belum terpasang di Ollama.`;
      setStatus(problems.length
        ? `Suara lokal: ${problems.join(", ")}.${modelNote}`
        : `Suara lokal siap (Whisper + macOS).${modelNote}`, problems.length || modelNote ? "warn" : "ok");
    } catch (error) {
      els.mic.disabled = true;
      setStatus(error.message, "warn");
    }
  }

  async function startRecording() {
    if (state.phase !== "idle" || els.mic.disabled) return;
    if (isBusy()) {
      setStatus("Tunggu jawaban sebelumnya selesai.", "warn");
      return;
    }
    const blocked = currentVoiceBlockReason();
    if (blocked) {
      setStatus(blocked, "warn");
      els.mic.disabled = true;
      return;
    }
    stopSpeaking();
    setPhase("recording");
    setStatus("Merekam di Mac ini… lepas tombol untuk mengirim.");
    state.startedAt = Date.now();
    state.releasedEarly = false;
    let capture = null;
    try {
      capture = state.preferCompanion ? await startCompanionCapture() : await startBrowserCapture();
    } catch (error) {
      if (!state.preferCompanion && state.service?.recorder) {
        // getUserMedia refused (Word's webview may not grant microphone
        // access). Remember it and record through the companion instead.
        console.warn("[TantularVoice] browser capture unavailable:", error?.name, error?.message);
        state.preferCompanion = true;
        try {
          capture = await startCompanionCapture();
          setStatus("Mikrofon panel tidak diizinkan; merekam lewat Companion lokal…");
        } catch (fallbackError) {
          setPhase("idle");
          setStatus(`Mikrofon tidak tersedia: ${fallbackError.message}`, "warn");
          return;
        }
      } else {
        setPhase("idle");
        setStatus(`Mikrofon tidak tersedia (${error?.name || "error"}): ${error?.message || error}`, "warn");
        return;
      }
    }
    // Released while the microphone was still opening: close it again so the
    // mic is never left live with nobody holding the button.
    if (state.phase !== "recording" || state.releasedEarly) {
      state.releasedEarly = false;
      capture.cancel();
      setPhase("idle");
      setStatus("Tahan tombol selama berbicara, lalu lepas.");
      return;
    }
    state.capture = capture;
    state.maxTimer = setTimeout(() => finishRecording(), MAX_RECORDING_MS);
  }

  async function finishRecording() {
    if (state.phase !== "recording") return;
    clearTimeout(state.maxTimer);
    const capture = state.capture;
    state.capture = null;
    const heldMs = Date.now() - state.startedAt;
    if (!capture) {
      // Released before the microphone finished opening; startRecording
      // closes it as soon as it opens.
      state.releasedEarly = true;
      return;
    }
    if (heldMs < MIN_RECORDING_MS) {
      capture.cancel();
      setPhase("idle");
      setStatus("Tahan tombol selama berbicara, lalu lepas.");
      return;
    }
    setPhase("transcribing");
    els.mic.textContent = "Menyalin ucapan…";
    setStatus("Menyalin ucapan secara lokal (Whisper)…");
    const lang = els.lang.value;
    try {
      const result = capture.kind === "companion"
        ? await voiceFetch(`/api/voice/record/stop?lang=${encodeURIComponent(lang)}`, { method: "POST" })
        : await voiceFetch(`/api/voice/transcribe?lang=${encodeURIComponent(lang)}`, {
          method: "POST",
          headers: { "Content-Type": "audio/wav" },
          body: await capture.stop()
        });
      const transcript = String(result.text || "").trim();
      if (!transcript) {
        setStatus("Tidak ada ucapan yang terdeteksi. Coba lagi lebih dekat ke mikrofon.", "warn");
        return;
      }
      // Re-check: the mode could have changed while Whisper ran.
      const blocked = currentVoiceBlockReason();
      if (blocked) {
        setStatus(blocked, "warn");
        return;
      }
      setPhase("thinking");
      els.mic.textContent = "Menunggu jawaban…";
      setStatus(`Terdengar (${LANG_LABELS[result.language] || result.language}). Mengirim ke model lokal…`);
      const outcome = await send(transcript, { voice: true });
      if (!outcome?.spoken || !els.speak.checked) {
        setStatus("Selesai.", "ok");
        return;
      }
      const speechLang = replyLanguage(outcome.spoken, result.language);
      setPhase("speaking");
      els.mic.textContent = "■ Hentikan suara";
      setStatus("Membacakan jawaban… (tekan tombol untuk berhenti)");
      const spoken = await voiceFetch("/api/voice/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: speakableText(outcome.spoken, speechLang), language: speechLang })
      }, 300_000);
      setStatus(spoken.completed ? "Selesai." : "Pembacaan dihentikan.", "ok");
    } catch (error) {
      addBubble("error", `Suara: ${error.message}`);
      setStatus("Gagal. Lihat pesan di atas.", "warn");
    } finally {
      setPhase("idle");
    }
  }

  function stopSpeaking() {
    voiceFetch("/api/voice/stop", { method: "POST" }, 5_000).catch(() => {});
  }

  els.mic.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (state.phase === "speaking") {
      stopSpeaking();
      return;
    }
    els.mic.setPointerCapture?.(event.pointerId);
    startRecording();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    els.mic.addEventListener(type, () => finishRecording());
  }
  els.mic.addEventListener("keydown", (event) => {
    if ((event.key === " " || event.key === "Enter") && !event.repeat) {
      event.preventDefault();
      if (state.phase === "speaking") stopSpeaking();
      else startRecording();
    }
  });
  els.mic.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      finishRecording();
    }
  });
  els.mic.addEventListener("contextmenu", (event) => event.preventDefault());

  refreshStatus();
  return { refreshStatus, stopSpeaking };
}

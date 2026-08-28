// Wires the deck data, adapter, voice controller, and intent router to the
// DOM. Keyboard/button/typed input all funnel through the same
// routeIntent() -> adapter.apply() pipeline as voice, so every input source
// produces the same normalized, validated command.

import { config } from "./config.js";
import { createCommand } from "./commandContract.js";
import { routeIntent } from "./intentRouter.js";
import { WebDeckAdapter } from "./webDeckAdapter.js";
import { VoiceController } from "./voiceController.js";

const els = {
  stage: document.getElementById("stage"),
  slideProgress: document.getElementById("slideProgress"),
  slideTitle: document.getElementById("slideTitle"),
  slideBody: document.getElementById("slideBody"),
  notesPane: document.getElementById("notesPane"),
  notesText: document.getElementById("notesText"),
  blankOverlay: document.getElementById("blankOverlay"),
  startOverlay: document.getElementById("startOverlay"),
  endOverlay: document.getElementById("endOverlay"),
  deckTitle: document.getElementById("deckTitle"),
  deckSubtitle: document.getElementById("deckSubtitle"),
  startButton: document.getElementById("startButton"),

  hud: document.getElementById("hud"),
  hudToggle: document.getElementById("hudToggle"),
  hudSlideNumber: document.getElementById("hudSlideNumber"),
  hudMicState: document.getElementById("hudMicState"),
  hudInterimTranscript: document.getElementById("hudInterimTranscript"),
  hudFinalTranscript: document.getElementById("hudFinalTranscript"),
  hudLastCommand: document.getElementById("hudLastCommand"),
  hudStatus: document.getElementById("hudStatus"),
  languageSelect: document.getElementById("languageSelect"),
  micButton: document.getElementById("micButton"),
  typedCommandForm: document.getElementById("typedCommandForm"),
  typedCommandInput: document.getElementById("typedCommandInput"),
  btnPrevious: document.getElementById("btnPrevious"),
  btnNext: document.getElementById("btnNext"),
  btnNotes: document.getElementById("btnNotes"),
  btnBlank: document.getElementById("btnBlank"),
  btnStart: document.getElementById("btnStart"),
  btnEnd: document.getElementById("btnEnd"),
};

let adapter = null;
let deckData = null;
let notesShown = false;

function setStatus(message, kind) {
  els.hudStatus.textContent = message || "";
  els.hudStatus.classList.remove("ok", "error");
  if (kind) els.hudStatus.classList.add(kind);
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function render(state) {
  const slide = adapter.getSlide(state.currentSlide);

  els.hudSlideNumber.textContent = `${state.currentSlide} / ${state.totalSlides}`;
  els.slideProgress.textContent = `Slide ${state.currentSlide} of ${state.totalSlides}`;

  if (slide) {
    els.slideTitle.textContent = slide.title;
    els.slideBody.innerHTML = "";
    (slide.body || []).forEach((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      els.slideBody.appendChild(li);
    });
    els.notesText.textContent = slide.notes || "(no notes)";
  }

  notesShown = state.notesVisible;
  els.notesPane.classList.toggle("hidden", !state.notesVisible);
  els.blankOverlay.classList.toggle("hidden", !state.blanked);

  els.startOverlay.classList.toggle("hidden", state.started && !state.ended);
  els.endOverlay.classList.toggle("hidden", !state.ended);
}

function updateMicUi(listening) {
  els.hudMicState.textContent = listening ? "listening" : "idle";
  els.hudMicState.classList.toggle("listening", listening);
  els.micButton.classList.toggle("listening", listening);
}

function showLastCommand(command) {
  els.hudLastCommand.textContent = JSON.stringify(command, null, 2);
}

async function dispatchTranscript(transcript, source, confidence) {
  const availableTopics = deckData.slides.map((s) => s.title);
  const command = await routeIntent(transcript, {
    source,
    confidence,
    config,
    availableTopics,
  });

  showLastCommand(command);

  if (command.action === "noop") {
    setStatus(`Could not understand: "${transcript}"`, "error");
    return;
  }

  const result = adapter.apply(command);
  setStatus(result.message, result.ok ? "ok" : "error");
}

// ---------- Voice controller ----------

const voice = new VoiceController({
  language: config.defaultLanguage,
  duplicateWindowMs: config.recognition.duplicateWindowMs,
  onStateChange: ({ listening }) => updateMicUi(listening),
  onResult: ({ transcript, isFinal, confidence }) => {
    if (isFinal) {
      els.hudFinalTranscript.textContent = transcript;
      els.hudInterimTranscript.textContent = "";
      dispatchTranscript(transcript, "voice", confidence ?? 1);
    } else {
      els.hudInterimTranscript.textContent = transcript;
    }
  },
  onError: ({ message }) => {
    updateMicUi(false);
    setStatus(message, "error");
  },
});

if (!voice.isSupported()) {
  els.micButton.disabled = true;
  els.micButton.textContent = "Mic unsupported — use typed commands";
  setStatus(
    "Speech recognition is not supported in this browser. Use the typed-command box or keyboard.",
    "error"
  );
}

els.languageSelect.value = config.defaultLanguage;
els.languageSelect.addEventListener("change", () => {
  voice.setLanguage(els.languageSelect.value);
});

// Push-to-talk: mic button (mouse + touch)
function startTalk() {
  if (isTypingTarget(document.activeElement)) return;
  voice.start();
}
function stopTalk() {
  voice.stop();
}

els.micButton.addEventListener("mousedown", startTalk);
els.micButton.addEventListener("touchstart", (e) => {
  e.preventDefault();
  startTalk();
});
["touchend", "touchcancel"].forEach((evt) => {
  els.micButton.addEventListener(evt, stopTalk);
});
// Release is bound on the WINDOW, not the button: "mouseleave" used to stop
// recognition the moment the cursor drifted off the button, which happens
// constantly while speaking, and a mouseup released outside the button never
// stopped it at all.
window.addEventListener("mouseup", () => {
  if (voice.isListening()) stopTalk();
});

// Push-to-talk: hold Space, only when not typing in an input.
let spaceHeld = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !spaceHeld && !isTypingTarget(e.target)) {
    spaceHeld = true;
    e.preventDefault();
    voice.start();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && spaceHeld) {
    spaceHeld = false;
    e.preventDefault();
    voice.stop();
  }
});

// ---------- Typed-command fallback ----------

els.typedCommandForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.typedCommandInput.value.trim();
  if (!text) return;
  els.typedCommandInput.value = "";
  dispatchTranscript(text, "text", 1);
});

// ---------- Buttons ----------

function dispatchDirect(action) {
  const command = createCommand({ action, source: "button", confidence: 1 });
  showLastCommand(command);
  const result = adapter.apply(command);
  setStatus(result.message, result.ok ? "ok" : "error");
}

els.btnPrevious.addEventListener("click", () => dispatchDirect("previous"));
els.btnNext.addEventListener("click", () => dispatchDirect("next"));
els.btnNotes.addEventListener("click", () => dispatchDirect(notesShown ? "hide_notes" : "show_notes"));
els.btnBlank.addEventListener("click", () => {
  const blanked = adapter.getState().blanked;
  dispatchDirect(blanked ? "resume" : "blank");
});
els.btnStart.addEventListener("click", () => dispatchDirect("start"));
els.btnEnd.addEventListener("click", () => dispatchDirect("end"));
els.startButton.addEventListener("click", () => dispatchDirect("start"));

els.hudToggle.addEventListener("click", () => {
  document.body.classList.toggle("hud-hidden");
});

// ---------- Keyboard navigation ----------

window.addEventListener("keydown", (e) => {
  if (isTypingTarget(e.target)) {
    if (e.key === "Escape") e.target.blur();
    return;
  }

  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
      e.preventDefault();
      dispatchDirect("next");
      break;
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      e.preventDefault();
      dispatchDirect("previous");
      break;
    case "Home": {
      e.preventDefault();
      const command = createCommand({ action: "goto_slide", slide: 1, source: "keyboard", confidence: 1 });
      showLastCommand(command);
      const result = adapter.apply(command);
      setStatus(result.message, result.ok ? "ok" : "error");
      break;
    }
    case "End": {
      e.preventDefault();
      const last = adapter.getState().totalSlides;
      const command = createCommand({ action: "goto_slide", slide: last, source: "keyboard", confidence: 1 });
      showLastCommand(command);
      const result = adapter.apply(command);
      setStatus(result.message, result.ok ? "ok" : "error");
      break;
    }
    case "n":
    case "N":
      dispatchDirect(notesShown ? "hide_notes" : "show_notes");
      break;
    case "b":
    case "B":
      dispatchDirect(adapter.getState().blanked ? "resume" : "blank");
      break;
    case "h":
    case "H":
      document.body.classList.toggle("hud-hidden");
      break;
    case "Escape":
      setStatus("");
      if (adapter.getState().blanked) dispatchDirect("resume");
      break;
    default:
      break;
  }
});

// ---------- Boot ----------

async function boot() {
  const response = await fetch("slides.json");
  deckData = await response.json();

  els.deckTitle.textContent = deckData.deck.title;
  els.deckSubtitle.textContent = deckData.deck.subtitle || "";
  document.title = deckData.deck.title;

  adapter = new WebDeckAdapter(deckData, {
    onChange: render,
    topicMatch: config.topicMatch,
  });

  render(adapter.getState());
  setStatus("Ready. Hold Space or the mic button to talk, or type a command below.");
}

boot().catch((err) => {
  setStatus(`Failed to load deck: ${err.message}`, "error");
});

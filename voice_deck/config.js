// Runtime configuration for the voice deck MVP. Safe to edit by hand; no
// build step required.

export const config = {
  // Default Web Speech API recognition language. id-ID and en-US are offered
  // in the HUD language selector.
  defaultLanguage: "id-ID",
  supportedLanguages: ["id-ID", "en-US"],

  ollama: {
    // Optional fallback intent router for free-form phrasing the
    // deterministic keyword parser doesn't recognize. The deterministic
    // parser always runs first; Ollama is only consulted when it returns
    // nothing. Set enabled:false to run fully offline/local-only with the
    // deterministic parser and typed-command fallback.
    enabled: true,
    endpoint: "http://localhost:11434/api/chat",
    model: "qwen2.5:7b",
    timeoutMs: 4000,
  },

  recognition: {
    interimResults: true,
    maxAlternatives: 1,
    // Two identical final results within this window are treated as one
    // duplicate event (common with Web Speech API restarts) and only the
    // first is dispatched as a command.
    duplicateWindowMs: 1200,
  },

  bridge: {
    // Rehearsal transport to the local native bridge (voice_deck/bridge).
    // OFF by default: the deck must work standalone, and enabling it should be
    // a deliberate act before a rehearsal, not something a demo inherits.
    //
    // The deck applies every command locally FIRST and never waits on the
    // bridge to redraw, so a bridge that is down only costs the mirror.
    enabled: false,
    endpoint: "http://127.0.0.1:8777",
    timeoutMs: 1500,
  },

  topicMatch: {
    // Minimum keyword score (see topicMatcher.js) required before a
    // goto_topic command is allowed to navigate. Below this, the command is
    // rejected rather than guessing.
    minScore: 1,
  },
};

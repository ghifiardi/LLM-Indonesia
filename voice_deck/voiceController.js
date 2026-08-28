// Push-to-talk wrapper around the browser Web Speech API. This controller
// NEVER listens continuously -- recognition only runs between start() and
// stop(), which callers drive from a held key or a held/tapped mic button.
//
// Honesty note: Web Speech API recognition in Chrome/Edge/Safari is NOT
// guaranteed to run offline -- most browsers stream audio to a vendor speech
// service to produce a transcript. Do not present this to an audience as an
// offline or private capability. See NATIVE_POWERPOINT_KEYNOTE_ROADMAP.md
// Phase N4 for a path to genuinely offline recognition.

export class VoiceController {
  constructor({ language, onResult, onStateChange, onError, duplicateWindowMs = 1200 } = {}) {
    this.language = language;
    this.onResult = onResult || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.onError = onError || (() => {});
    this.duplicateWindowMs = duplicateWindowMs;

    this.recognition = null;
    this.listening = false;
    this.lastFinal = { text: "", at: 0 };
    // A push-to-talk release often ends recognition before the engine promotes
    // its interim guess to a final result: Chrome then fires error "aborted"
    // and the transcript is discarded. The words were already on screen, so
    // dropping them reads as "the mic heard me and nothing happened". Keep the
    // last interim so a session that ends without a final can still act on it.
    this.pendingInterim = "";
    this.gotFinal = false;

    const SpeechRecognitionImpl =
      typeof window !== "undefined" &&
      (window.SpeechRecognition || window.webkitSpeechRecognition);
    this.supported = Boolean(SpeechRecognitionImpl);

    if (this.supported) {
      this.recognition = new SpeechRecognitionImpl();
      this.recognition.continuous = false;
      this.recognition.interimResults = true;
      this.recognition.maxAlternatives = 1;
      this.recognition.lang = this.language;

      this.recognition.onresult = (event) => this._handleResult(event);
      this.recognition.onerror = (event) => this._handleError(event);
      this.recognition.onend = () => this._handleEnd();
    }
  }

  isSupported() {
    return this.supported;
  }

  isListening() {
    return this.listening;
  }

  setLanguage(language) {
    this.language = language;
    if (this.recognition) this.recognition.lang = language;
  }

  start() {
    if (!this.supported) {
      this.onError({ message: "Speech recognition is not supported in this browser." });
      return;
    }
    if (this.listening) return;
    try {
      this.recognition.lang = this.language;
      this.pendingInterim = "";
      this.gotFinal = false;
      this.recognition.start();
      this.listening = true;
      this.onStateChange({ listening: true });
    } catch (err) {
      this.onError({ message: `Could not start recognition: ${err.message}` });
    }
  }

  stop() {
    if (!this.supported || !this.listening) return;
    try {
      this.recognition.stop();
    } catch (_err) {
      // stop() can throw if recognition already ended between the caller's
      // check and this call -- safe to ignore, onend() will still fire.
    }
  }

  _handleResult(event) {
    let interim = "";
    let final = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) {
        final += result[0].transcript;
      } else {
        interim += result[0].transcript;
      }
    }

    if (interim) {
      this.pendingInterim = interim.trim();
      this.onResult({ transcript: interim, isFinal: false, confidence: null });
    }

    if (final) {
      const trimmed = final.trim();
      const now = Date.now();
      const isDuplicate =
        trimmed.length > 0 &&
        trimmed === this.lastFinal.text &&
        now - this.lastFinal.at < this.duplicateWindowMs;

      if (!isDuplicate && trimmed.length > 0) {
        this.gotFinal = true;
        this.pendingInterim = "";
        this.lastFinal = { text: trimmed, at: now };
        const lastAlt = event.results[event.results.length - 1][0];
        const confidence =
          typeof lastAlt.confidence === "number" && !Number.isNaN(lastAlt.confidence)
            ? lastAlt.confidence
            : 1;
        this.onResult({ transcript: trimmed, isFinal: true, confidence });
      }
    }
  }

  // "aborted" and "no-speech" are ordinary outcomes of push-to-talk, not
  // faults: they fire whenever a session is stopped before the engine settles.
  // Reporting them in red taught the presenter to distrust a working mic.
  static get BENIGN_ERRORS() {
    return new Set(["aborted", "no-speech"]);
  }

  _handleError(event) {
    this.listening = false;
    this.onStateChange({ listening: false });

    const benign = VoiceController.BENIGN_ERRORS.has(event.error);
    const salvaged = benign ? this._flushPendingInterim() : false;
    if (salvaged) return;

    this.onError({
      message: benign
        ? "Tidak ada ucapan yang tertangkap. Tahan Space lebih lama, lalu bicara."
        : `Recognition error: ${event.error}`,
      code: event.error,
      recoverable: benign,
    });
  }

  _handleEnd() {
    this.listening = false;
    this.onStateChange({ listening: false });
    this._flushPendingInterim();
  }

  // Promote the last interim transcript to a final result when the session
  // produced none. Confidence is reported honestly as partial so a caller can
  // treat it more cautiously than a real final.
  _flushPendingInterim() {
    const text = (this.pendingInterim || "").trim();
    this.pendingInterim = "";
    if (this.gotFinal || !text) return false;

    const now = Date.now();
    if (text === this.lastFinal.text && now - this.lastFinal.at < this.duplicateWindowMs) {
      return false;
    }
    this.gotFinal = true;
    this.lastFinal = { text, at: now };
    this.onResult({ transcript: text, isFinal: true, confidence: 0.5, salvaged: true });
    return true;
  }
}

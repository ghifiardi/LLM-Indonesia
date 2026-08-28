// Bilingual (id-ID / en-US) intent routing: transcript (or typed text) in,
// a validated normalized command out. Deterministic keyword parsing always
// runs first and is preferred; Ollama is only consulted when the
// deterministic parser can't classify the utterance at all, and is only ever
// sent the transcript plus slide *titles* (never speaker notes or slide
// bodies) so it has just enough context to resolve a goto_topic query.

import { createCommand, validateCommand } from "./commandContract.js";

const NUMBER_WORDS_EN = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const NUMBER_WORDS_ID = {
  satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5,
  enam: 6, tujuh: 7, delapan: 8, sembilan: 9, sepuluh: 10,
};

function extractNumber(text) {
  const digitMatch = text.match(/\d+/);
  if (digitMatch) return parseInt(digitMatch[0], 10);
  for (const word of text.split(/\s+/)) {
    if (NUMBER_WORDS_EN[word] !== undefined) return NUMBER_WORDS_EN[word];
    if (NUMBER_WORDS_ID[word] !== undefined) return NUMBER_WORDS_ID[word];
  }
  return null;
}

// Order matters: checked top to bottom, first match wins.
const KEYWORD_RULES = [
  {
    action: "show_notes",
    patterns: [
      /\bshow notes?\b/, /\bnotes on\b/, /\bopen notes?\b/,
      /\btampilkan catatan\b/, /\btampilkan notes\b/, /\bbuka catatan\b/,
    ],
  },
  {
    action: "hide_notes",
    patterns: [/\bhide notes?\b/, /\bnotes off\b/, /\bsembunyikan catatan\b/, /\btutup catatan\b/],
  },
  {
    action: "blank",
    patterns: [
      /\bblank( the)?( screen)?\b/, /\bblack screen\b/, /\bgo dark\b/,
      /\blayar kosong\b/, /\bkosongkan layar\b/, /\blayar hitam\b/, /\bhitamkan layar\b/,
    ],
  },
  {
    action: "resume",
    patterns: [/\bresume\b/, /\bunblank\b/, /\blanjutkan tampilan\b/, /\btampilkan lagi\b/],
  },
  {
    action: "start",
    patterns: [/\bstart( the)?( presentation| show)?\b/, /\bmulai( presentasi)?\b/, /\bbegin( presentation)?\b/],
  },
  {
    action: "end",
    patterns: [
      /\bend( the)?( presentation| show)?\b/, /\bstop presentation\b/, /\bfinish( the)?( presentation)?\b/,
      /\bakhiri\b/, /\bselesai(kan)?( presentasi)?\b/,
    ],
  },
  {
    action: "next",
    patterns: [/\bnext( slide)?\b/, /\bforward\b/, /\blanjut(kan)?\b/, /\bselanjutnya\b/, /\bmaju\b/],
  },
  {
    action: "previous",
    patterns: [/\bprevious( slide)?\b/, /\bgo back\b/, /\bback\b/, /\bsebelumnya\b/, /\bmundur\b/, /\bkembali\b/],
  },
];

const GOTO_SLIDE_PATTERNS = [
  /\bgo to slide\b/, /\bslide number\b/, /\bslide\b/, /\bke slide\b/, /\bmenuju slide\b/, /\bnomor slide\b/,
];

// Ordered most-specific first: "buka bagian keamanan" must bind the topic to
// "keamanan", not to "bagian keamanan". Topic rules run AFTER GOTO_SLIDE_PATTERNS
// and KEYWORD_RULES, so "buka slide lima" and "buka catatan" are already claimed
// by the slide-number and notes rules before a bare "buka (.+)" can swallow them.
const GOTO_TOPIC_PATTERNS = [
  // English
  /\bgo to (?:the )?topic (?:of |about |on )?(.+)/,
  /\bgo to (?:the )?section (?:on |about |called )?(.+)/,
  /\b(?:jump|skip|navigate) to (?:the )?(?:section (?:on |about )?)?(.+)/,
  /\btake me to (?:the )?(?:section (?:on |about )?)?(.+)/,
  /\bopen (?:the )?(?:section (?:on |about )?)?(.+)/,
  /\bsection (?:on |about |called )(.+)/,
  /\bgo to (.+)/,
  /\bshow me (.+)/,
  // Indonesian. "bagian"/"topik"/"halaman" are the natural section words; each
  // is optional so both "buka bagian keamanan" and "buka keamanan" resolve to
  // the same query.
  /\bbuka (?:bagian |topik |halaman |bab )?(.+)/,
  /\b(?:pergi |lompat )?ke (?:bagian|topik|halaman|bab) (.+)/,
  /\btampilkan (?:bagian |topik |halaman )(.+)/,
  /\btopik (?:tentang )?(.+)/,
  /\btentang (.+)/,
  /\bcari (.+)/,
];

function finalize(fields) {
  const command = createCommand(fields);
  const result = validateCommand(command);
  return result.ok ? command : null;
}

// Try the deterministic bilingual keyword parser. Returns a validated
// command, or null if nothing matched (caller may then try Ollama).
export function parseDeterministic(rawTranscript, { source = "voice", confidence = 1 } = {}) {
  const transcript = (rawTranscript || "").trim();
  const text = transcript.toLowerCase();
  if (!text) return null;

  // goto_slide takes priority when a number accompanies a "slide" keyword,
  // so "go to slide 5" doesn't fall through to the generic "go to" topic rule.
  if (GOTO_SLIDE_PATTERNS.some((p) => p.test(text))) {
    const n = extractNumber(text);
    if (n !== null) {
      return finalize({ action: "goto_slide", slide: n, source, confidence, transcript });
    }
  }

  for (const rule of KEYWORD_RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      return finalize({ action: rule.action, source, confidence, transcript });
    }
  }

  for (const pattern of GOTO_TOPIC_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1] && match[1].trim().length > 0) {
      return finalize({ action: "goto_topic", query: match[1].trim(), source, confidence, transcript });
    }
  }

  return null;
}

async function callOllama({ transcript, source, confidence, ollamaConfig, availableTopics }) {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this environment");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ollamaConfig.timeoutMs);

  try {
    const systemPrompt = [
      "You are an intent router for a presentation remote control.",
      'Return ONLY strict JSON: {"action":"next|previous|goto_slide|goto_topic|show_notes|hide_notes|blank|resume|start|end|noop","slide":<integer, goto_slide only>,"query":"<string, goto_topic only>"}',
      "No other fields, no prose, no markdown fences. If unsure, return {\"action\":\"noop\"}.",
      availableTopics && availableTopics.length
        ? `Known slide topics: ${availableTopics.join(", ")}`
        : "",
    ].filter(Boolean).join("\n");

    const response = await fetch(ollamaConfig.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: ollamaConfig.model,
        stream: false,
        format: "json",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: transcript },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`ollama http ${response.status}`);
    }

    const data = await response.json();
    const content = data && data.message && data.message.content;
    if (!content) throw new Error("ollama returned no content");

    const parsed = JSON.parse(content);
    const command = createCommand({
      action: parsed.action,
      slide: parsed.slide,
      query: parsed.query,
      source,
      confidence: typeof confidence === "number" ? confidence * 0.85 : 0.5,
      transcript,
    });
    const result = validateCommand(command);
    if (!result.ok) throw new Error(`ollama produced invalid command: ${result.error}`);
    return command;
  } finally {
    clearTimeout(timeout);
  }
}

// Route a raw transcript/typed string to a normalized command. Deterministic
// parsing first; Ollama fallback second (if enabled and reachable); noop last.
// Never throws -- always resolves to a valid command object.
export async function routeIntent(rawTranscript, options = {}) {
  const { source = "voice", confidence = 1, config, availableTopics = [] } = options;

  const deterministic = parseDeterministic(rawTranscript, { source, confidence });
  if (deterministic) return deterministic;

  const ollamaConfig = config && config.ollama;
  if (ollamaConfig && ollamaConfig.enabled) {
    try {
      return await callOllama({ transcript: rawTranscript, source, confidence, ollamaConfig, availableTopics });
    } catch (_err) {
      // Fall through to noop -- caller surfaces the failed command as-is.
    }
  }

  return createCommand({ action: "noop", source, confidence: 0, transcript: rawTranscript });
}

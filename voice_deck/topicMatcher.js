// Local, deterministic topic-to-slide matching. Runs entirely client-side so
// spoken/typed topic queries never need to leave the browser for the common
// case -- the intent router only calls out to Ollama for the *parsing* step
// when the deterministic keyword parser can't classify an utterance at all.

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const WEIGHTS = { title: 3, tags: 2, body: 1 };

function bodyText(slide) {
  return Array.isArray(slide.body) ? slide.body.join(" ") : String(slide.body || "");
}

function scoreSlide(slide, queryTokens) {
  const titleTokens = new Set(tokenize(slide.title));
  const tagTokens = new Set((slide.tags || []).flatMap(tokenize));
  const bodyTokens = new Set(tokenize(bodyText(slide)));

  let score = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) score += WEIGHTS.title;
    if (tagTokens.has(token)) score += WEIGHTS.tags;
    if (bodyTokens.has(token)) score += WEIGHTS.body;
  }
  return score;
}

// Returns the best-matching slide number (1-indexed position in `slides`,
// matching the `slide` field used by goto_slide) for a free-text query, or
// null if nothing scores at or above minScore.
export function matchTopic(query, slides, { minScore = 1 } = {}) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || !Array.isArray(slides) || slides.length === 0) {
    return null;
  }

  let best = null;
  let bestScore = 0;
  slides.forEach((slide, index) => {
    const score = scoreSlide(slide, queryTokens);
    if (score > bestScore) {
      bestScore = score;
      best = index + 1;
    }
  });

  return bestScore >= minScore ? best : null;
}

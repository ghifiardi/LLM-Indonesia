// Grounded group headings for the automatic re-layout. One small model call
// names each content group in two to four words built from the slide's own
// words; anything else falls back to the group's first item. Never a
// placeholder like "Kolom 1", never a new term. Pure validation + injected
// model call.
import { runTantular } from "../tantularClient.js";
import { extractJsonObject, detectSlideLanguage } from "../deck/deckPlanner.js";

const str = (v) => String(v ?? "").trim();
const stem = (w) => w.replace(/(ies|ied)$/, "y").replace(/(ing|ed|es|s)$/, "");
const tokens = (text) => str(text).toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length >= 3).map(stem);

export function validateGroupHeadings(headings, groups, slideText) {
  const known = new Set(tokens(slideText));
  const list = Array.isArray(groups) ? groups : [];
  return list.map((g, i) => {
    if (str(g?.heading)) return { text: str(g.heading), source: "inline" };
    const fallback = { text: str(g?.items?.[0]) || `Bagian ${i + 1}`, source: "fallback" };
    const candidate = str(Array.isArray(headings) ? headings[i] : "");
    if (!candidate) return fallback;
    const words = candidate.split(/\s+/);
    if (words.length < 1 || words.length > 4 || candidate.length > 40) return fallback;
    if (/^(kolom|bagian|kelompok|group|column)\s*\d+$/i.test(candidate)) return fallback;
    const content = tokens(candidate);
    if (!content.length) return fallback;
    const hits = content.filter((t) => known.has(t)).length;
    return hits * 2 >= content.length ? { text: candidate, source: "model" } : fallback;
  });
}

const SYSTEM = `Anda memberi judul singkat untuk kelompok poin pada satu slide.
Balas HANYA JSON: {"headings":["...","..."]} — satu judul per kelompok, urutan sama.
Aturan: 2–4 kata, disusun dari kata-kata yang ada di slide, bukan kalimat, bukan istilah baru, bukan "Kolom 1".`;

export async function requestGroupHeadings({ groups, slideText, run = runTantular, signal } = {}) {
  const list = Array.isArray(groups) ? groups : [];
  const language = detectSlideLanguage(slideText) === "en" ? "BAHASA OUTPUT: English." : "BAHASA OUTPUT: Bahasa Indonesia.";
  const body = list.map((g, i) => `Kelompok ${i + 1}:\n${(g.items || []).map((it) => `- ${it}`).join("\n")}`).join("\n\n");
  let raw = "";
  try {
    raw = await run({
      system: SYSTEM,
      user: `${language}\nJudul slide: "${str(list.title || "")}"\n\n${body}\n\nJSON saja.`,
      maxTokens: 200, temperature: 0.1, task: "deck", jsonMode: true, signal
    });
  } catch (_) {
    return validateGroupHeadings([], list, slideText);
  }
  const parsed = extractJsonObject(String(raw || ""));
  const headings = Array.isArray(parsed?.headings) ? parsed.headings.map(str) : [];
  return validateGroupHeadings(headings, list, slideText);
}

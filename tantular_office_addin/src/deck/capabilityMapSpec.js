// Deterministic parser for capability-map screenshots (domains + status legend).
// Used after OCR/vision so we do not depend on a small text model to preserve
// the structure of dense platform diagrams.

const DOMAIN_NAMES = [
  "Identity", "Devices", "Network", "Data", "Application", "Detection", "Response", "Enablement"
];

const STATUS = {
  fully: "Fully implemented",
  partial: "Partially implemented",
  not: "Not implemented",
  unknown: "Status perlu divalidasi"
};

export function buildCapabilityMapSpec(text, slideCount = 6) {
  const parsed = parseCapabilityMap(text);
  if (parsed.domains.length < 3) return null;

  const title = parsed.title || "Cyber Security Platform Baseline";
  const subtitle = parsed.subtitle || "Capability map, implementation status, dan roadmap prioritas";
  const allItems = parsed.domains.flatMap((d) => d.items.map((item) => ({ ...item, domain: d.name })));
  const fully = allItems.filter((i) => i.statusKey === "fully");
  const partial = allItems.filter((i) => i.statusKey === "partial");
  const notImpl = allItems.filter((i) => i.statusKey === "not");
  const gaps = [...notImpl, ...partial].slice(0, 12);

  const slides = [
    { type: "title", headline: title, subhead: subtitle },
    {
      type: "cards",
      headline: "Capability Map per Domain",
      cards: parsed.domains.slice(0, 8).map((d) => ({
        title: d.name,
        desc: summarizeDomain(d)
      }))
    },
    {
      type: "metrics",
      headline: "Ringkasan Status Implementasi",
      metrics: [
        { value: String(fully.length), label: "Fully implemented" },
        { value: String(partial.length), label: "Partially implemented" },
        { value: String(notImpl.length), label: "Not implemented" },
        { value: String(parsed.domains.length), label: "Domain keamanan" }
      ]
    },
    {
      type: "columns",
      headline: "Status Detail yang Perlu Dipertahankan",
      columns: [
        { title: "Fully implemented", points: compactItems(fully, 6) },
        { title: "Partially implemented", points: compactItems(partial, 6) },
        { title: "Not implemented", points: compactItems(notImpl, 6) }
      ]
    },
    {
      type: "cards",
      headline: "Prioritas Gap dan Perhatian Manajemen",
      cards: gaps.slice(0, 6).map((item) => ({
        title: `${item.domain}: ${item.name}`,
        desc: item.status
      }))
    },
    {
      type: "columns",
      headline: "Roadmap Revamp: Dari Baseline ke Aksi",
      columns: [
        { title: "Quick wins", points: ["Validasi status setiap domain", "Pisahkan capability map dari gap analysis", "Tetapkan owner untuk item kuning/abu-abu"] },
        { title: "3–6 bulan", points: ["Prioritaskan not implemented berisiko tinggi", "Lengkapi kontrol data dan aplikasi", "Rapikan proses detection/response"] },
        { title: "6–12 bulan", points: ["Standarkan platform governance", "Automasi posture management", "Review maturity per kuartal"] }
      ]
    },
    {
      type: "closing",
      headline: "Keputusan yang Dibutuhkan",
      bullets: [
        "Sepakati domain prioritas untuk Q1 berikutnya.",
        "Tentukan target status dari partially/not implemented.",
        "Jadikan baseline ini sebagai dashboard eksekutif berkala."
      ]
    }
  ];

  const target = Math.min(8, Math.max(4, Number(slideCount) || 6));
  return { title, subtitle, slides: slides.slice(0, target - 1).concat(slides[slides.length - 1]) };
}

export function parseCapabilityMap(text) {
  const value = String(text || "");
  const title = extractAfter(value, /JUDUL\s*:\s*(.+)/i) || extractAfter(value, /TITLE\s*:\s*(.+)/i) || "";
  const subtitle = extractAfter(value, /SUBJUDUL\s*:\s*(.+)/i) || extractAfter(value, /SUBTITLE\s*:\s*(.+)/i) || "";
  const domains = [];

  // Pattern from our vision prompt: "- Domain: item (status), item (status)".
  // Parse line-by-line so section headers like "GRUP:" do not swallow the next
  // domain line.
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^\s*[-•]?\s*([A-Za-z][A-Za-z /&-]{2,28})\s*:\s*(.+)$/i);
    if (!match) continue;
    const name = normalizeDomain(match[1]);
    if (!name || ["JUDUL", "SUBJUDUL", "LEGENDA", "CATATAN", "GRUP"].includes(name.toUpperCase())) continue;
    if (!DOMAIN_NAMES.some((d) => d.toLowerCase() === name.toLowerCase())) continue;
    const items = parseItems(match[2]);
    if (items.length) domains.push({ name, items });
  }

  // Fallback for OCR output that lists domain headers and item lines separately.
  if (domains.length < 3) {
    const lines = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let current = null;
    for (const line of lines) {
      const maybeDomain = normalizeDomain(line.replace(/[:：].*$/, ""));
      if (DOMAIN_NAMES.some((d) => d.toLowerCase() === maybeDomain.toLowerCase())) {
        current = { name: maybeDomain, items: [] };
        domains.push(current);
        const tail = line.includes(":") ? line.split(/[:：]/).slice(1).join(":") : "";
        if (tail.trim()) current.items.push(...parseItems(tail));
        continue;
      }
      if (current && !/^JUDUL|SUBJUDUL|LEGENDA|CATATAN/i.test(line)) {
        current.items.push(...parseItems(line));
      }
    }
  }

  // Deduplicate domains and items.
  const byName = new Map();
  for (const d of domains) {
    if (!byName.has(d.name)) byName.set(d.name, { name: d.name, items: [] });
    byName.get(d.name).items.push(...d.items);
  }
  const finalDomains = [...byName.values()].map((d) => ({
    name: d.name,
    items: dedupeItems(d.items).slice(0, 14)
  })).filter((d) => d.items.length);

  return { title, subtitle, domains: finalDomains };
}

function parseItems(text) {
  return String(text || "")
    .split(/,|;|\n|\u2022/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const statusKey = statusKeyFor(part);
      const name = part
        .replace(/\((fully implemented|partially implemented|not implemented|teal|green|yellow|gray|grey|abu-abu|kuning|hijau|not|partial|fully)[^)]+\)/ig, "")
        .replace(/\b(fully implemented|partially implemented|not implemented|teal|green|yellow|gray|grey|abu-abu|kuning|hijau)\b/ig, "")
        .replace(/\s*\(\s*\)\s*/g, "")
        .replace(/[-–—]\s*$/g, "")
        .trim();
      return name ? { name, statusKey, status: STATUS[statusKey] } : null;
    })
    .filter(Boolean);
}

function statusKeyFor(text) {
  const lower = String(text || "").toLowerCase();
  if (/not implemented|gray|grey|abu-abu|belum|tidak/i.test(lower)) return "not";
  if (/partially|yellow|kuning|partial|sebagian/i.test(lower)) return "partial";
  if (/fully|teal|green|hijau|implemented/i.test(lower)) return "fully";
  return "unknown";
}

function summarizeDomain(domain) {
  const counts = countStatus(domain.items);
  const sample = domain.items.slice(0, 5).map((i) => i.name).join(", ");
  const status = [`${counts.fully} full`, `${counts.partial} partial`, `${counts.not} not`].join(" · ");
  return `${status}. ${sample}${domain.items.length > 5 ? ", ..." : ""}`;
}

function compactItems(items, max) {
  return items.slice(0, max).map((i) => `${i.domain}: ${i.name}`);
}

function countStatus(items) {
  return items.reduce((acc, item) => {
    acc[item.statusKey] = (acc[item.statusKey] || 0) + 1;
    return acc;
  }, { fully: 0, partial: 0, not: 0, unknown: 0 });
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.name.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizeDomain(name) {
  const clean = String(name || "").replace(/^[-•\d.\s]+/, "").trim();
  const found = DOMAIN_NAMES.find((d) => d.toLowerCase() === clean.toLowerCase());
  return found || clean;
}

function extractAfter(text, pattern) {
  const match = String(text || "").match(pattern);
  return match ? match[1].trim() : "";
}

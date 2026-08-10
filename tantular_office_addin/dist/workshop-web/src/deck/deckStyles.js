// Tantular Deck Studio — design system routes.
// Each pack is a complete token set: background treatment, decorative motif,
// a readable palette, a type scale, and chrome (footer/page-number) toggles.
// pptxBuilder.js consumes ONLY these tokens (plus a small motif-drawing map) —
// slide geometry (box positions) never changes between packs, only the look.

export const PACKS = {
  nusantara: {
    id: "nusantara",
    name: "Nusantara",
    label: "Nusantara",
    hint: "Hangat & heritage — motif sudut, aksen merah-emas.",
    background: { kind: "solid", bg: "#FFFDF8" },
    motif: "corners",
    palette: { bg: "#FFFDF8", ink: "#2B2118", muted: "#7A6A58", accent: "#A6351D", accent2: "#D9A441" },
    type_scale: { display: 42, h1: 28, body: 16, caption: 11, boldHeadings: true },
    chrome: { footer: true, slideNumber: true },
    // legacy flat fields consumed directly by the slide emitters below
    panel: "#F5EBDD",
    panelAlt: "#ECDCC4",
    onAccent: "#FFFFFF",
    heroBg: "#FFF3E2",
    font: "Segoe UI"
  },
  monokrom: {
    id: "monokrom",
    name: "Monokrom",
    label: "Monokrom",
    hint: "Tinta gelap, satu aksen tegas, garis pemisah rapi.",
    background: { kind: "solid", bg: "#111318" },
    motif: "rules",
    palette: { bg: "#111318", ink: "#F5F6F8", muted: "#9AA0AC", accent: "#E4572E", accent2: "#5B5F6B" },
    type_scale: { display: 40, h1: 26, body: 15.5, caption: 11, boldHeadings: true },
    chrome: { footer: true, slideNumber: true },
    panel: "#1A1D24",
    panelAlt: "#22252E",
    onAccent: "#111318",
    heroBg: "#0B0C10",
    font: "Segoe UI"
  },
  samudra: {
    id: "samudra",
    name: "Samudra",
    label: "Samudra",
    hint: "Gradasi biru laut dalam, aksen teal & magenta.",
    background: { kind: "gradient", from: "#061A33", to: "#0B3D66", angle: 60 },
    motif: "dots",
    palette: { bg: "#0B2A4A", ink: "#F5F8FC", muted: "#9DB2CE", accent: "#17B0A6", accent2: "#E5237E" },
    type_scale: { display: 42, h1: 27, body: 16, caption: 11, boldHeadings: true },
    chrome: { footer: true, slideNumber: true },
    panel: "#12294A",
    panelAlt: "#173463",
    onAccent: "#04121F",
    heroBg: "#0A1A31",
    font: "Segoe UI"
  },
  terang: {
    id: "terang",
    name: "Terang",
    label: "Terang",
    hint: "Minimal terang, banyak ruang kosong, titik dekoratif halus.",
    background: { kind: "solid", bg: "#FFFFFF" },
    motif: "dots",
    palette: { bg: "#FFFFFF", ink: "#111827", muted: "#6B7280", accent: "#2563EB", accent2: "#10B981" },
    type_scale: { display: 40, h1: 26, body: 16, caption: 11.5, boldHeadings: false },
    chrome: { footer: true, slideNumber: false },
    panel: "#F5F7FA",
    panelAlt: "#EBEEF3",
    onAccent: "#FFFFFF",
    heroBg: "#FFFFFF",
    font: "Segoe UI"
  },
  tegas: {
    id: "tegas",
    name: "Tegas",
    label: "Tegas",
    hint: "Panel gelap tegas, band aksen tebal, kontras tinggi.",
    background: { kind: "panel", bg: "#0F1118", panel: "#181B26" },
    motif: "band",
    palette: { bg: "#0F1118", ink: "#FFFFFF", muted: "#A2A8BE", accent: "#6C5CE7", accent2: "#00D1B2" },
    type_scale: { display: 44, h1: 28, body: 16.5, caption: 11, boldHeadings: true },
    chrome: { footer: true, slideNumber: true },
    panel: "#181B26",
    panelAlt: "#222636",
    onAccent: "#0B0C12",
    heroBg: "#121420",
    font: "Segoe UI"
  },
  akademik: {
    id: "akademik",
    name: "Akademik",
    label: "Akademik",
    hint: "Grid garis akademis, biru navy & emas pustaka.",
    background: { kind: "solid", bg: "#FBFCFE" },
    motif: "rules",
    palette: { bg: "#FBFCFE", ink: "#14213D", muted: "#667085", accent: "#234B75", accent2: "#C58A2A" },
    type_scale: { display: 38, h1: 25, body: 15, caption: 11, boldHeadings: true },
    chrome: { footer: true, slideNumber: true },
    panel: "#EEF4FF",
    panelAlt: "#E4ECF8",
    onAccent: "#FFFFFF",
    heroBg: "#F7FAFF",
    font: "Segoe UI"
  }
};

// "Bebas / custom" — same id (`custom_freeform`) as before the design-system
// packs landed, so the existing dropdown branch in src/taskpane.js keeps
// working unchanged. Its resolved look starts from this sensible neutral
// base and is then transformed by the pre-pack keyword inference (see
// inferStyleFromInstructions below) plus the explicit-hex override in
// applyProjectPalette — i.e. it "follows the style guide, brand colors, and
// visual direction" supplied in the project instructions, same as before.
const CUSTOM_FREEFORM = {
  id: "custom_freeform",
  name: "Bebas / custom",
  label: "Bebas / custom",
  hint: "Ikuti panduan gaya, warna brand, dan arahan visual di instruksi project.",
  background: { kind: "solid", bg: "#FFFFFF" },
  motif: "none",
  palette: { bg: "#FFFFFF", ink: "#111827", muted: "#667085", accent: "#1F6FEB", accent2: "#A6351D" },
  type_scale: { display: 40, h1: 26, body: 16, caption: 11, boldHeadings: true },
  chrome: { footer: true, slideNumber: true },
  panel: "#F7F8FA",
  panelAlt: "#EEF2F7",
  onAccent: "#FFFFFF",
  heroBg: "#FFFFFF",
  font: "Segoe UI"
};

export const DEFAULT_STYLE = "nusantara";

export function getStyle(styleId, projectInstructions = "") {
  const base = styleId === CUSTOM_FREEFORM.id ? CUSTOM_FREEFORM : (PACKS[styleId] || PACKS[DEFAULT_STYLE]);
  const flat = {
    ...base,
    bg: base.background.bg,
    accent: base.palette.accent,
    accent2: base.palette.accent2,
    title: base.palette.ink,
    text: base.palette.ink,
    muted: base.palette.muted
  };
  const styled = styleId === CUSTOM_FREEFORM.id ? inferStyleFromInstructions(flat, projectInstructions) : flat;
  return applyProjectPalette(styled, projectInstructions);
}

export function styleOptions() {
  const named = Object.values(PACKS).map((p) => ({
    id: p.id,
    name: p.name,
    label: p.label,
    hint: p.hint,
    background: p.background,
    motif: p.motif,
    palette: p.palette,
    type_scale: p.type_scale,
    chrome: p.chrome
  }));
  return [
    ...named,
    {
      id: CUSTOM_FREEFORM.id,
      name: CUSTOM_FREEFORM.name,
      label: CUSTOM_FREEFORM.label,
      hint: CUSTOM_FREEFORM.hint,
      background: CUSTOM_FREEFORM.background,
      motif: CUSTOM_FREEFORM.motif,
      palette: CUSTOM_FREEFORM.palette,
      type_scale: CUSTOM_FREEFORM.type_scale,
      chrome: CUSTOM_FREEFORM.chrome
    }
  ];
}

export function extractHexPalette(text) {
  const matches = String(text || "").match(/#[0-9a-fA-F]{6}\b/g) || [];
  const seen = new Set();
  return matches
    .map((c) => c.toUpperCase())
    .filter((c) => {
      if (seen.has(c)) return false;
      seen.add(c);
      return true;
    });
}

// Keyword inference for the "Bebas / custom" pack only: nudges the flat
// custom_freeform palette toward a mood implied by the project instructions
// (dark/academic/warm/minimal), same behavior as before the design-system
// packs existed. Named packs are unaffected.
function inferStyleFromInstructions(style, projectInstructions) {
  const text = String(projectInstructions || "").toLowerCase();
  const out = { ...style };

  if (/\b(dark|gelap|neon|cyber|futuristic|futuristik|terminal|black)\b/.test(text)) {
    Object.assign(out, {
      bg: "#0B1020",
      panel: "#141B2D",
      panelAlt: "#1F2A44",
      accent: "#24BDAD",
      accent2: "#EC008C",
      title: "#F8FAFC",
      text: "#E5E7EB",
      muted: "#A8B3C7",
      onAccent: "#07111F",
      heroBg: "#070B16"
    });
  } else if (/\b(academic|akademik|research|paper|jurnal|lecture|kuliah|university|universitas)\b/.test(text)) {
    Object.assign(out, {
      bg: "#FBFCFE",
      panel: "#EEF4FF",
      panelAlt: "#E4ECF8",
      accent: "#234B75",
      accent2: "#C58A2A",
      title: "#14213D",
      text: "#25364D",
      muted: "#667085",
      onAccent: "#FFFFFF",
      heroBg: "#F7FAFF"
    });
  } else if (/\b(warm|hangat|earth|natural|heritage|batik|premium|luxury|elegant|elegan)\b/.test(text)) {
    Object.assign(out, {
      bg: "#FFFDF8",
      panel: "#F5EBDD",
      panelAlt: "#ECDCC4",
      accent: "#A6351D",
      accent2: "#D9A441",
      title: "#2B2118",
      text: "#3C3026",
      muted: "#7A6A58",
      onAccent: "#FFFFFF",
      heroBg: "#FFF8EC"
    });
  } else if (/\b(minimal|minimalist|minimalis|clean|bersih|white|putih|editorial)\b/.test(text)) {
    Object.assign(out, {
      bg: "#FFFFFF",
      panel: "#F5F7FA",
      panelAlt: "#EBEEF3",
      accent: "#111827",
      accent2: "#7C3AED",
      title: "#111827",
      text: "#374151",
      muted: "#6B7280",
      onAccent: "#FFFFFF",
      heroBg: "#FFFFFF"
    });
  }

  return out;
}

// Optional opt-in override: if the user's instructions carry explicit brand
// hex colors, use those for accent/accent2 while keeping the chosen pack's
// background treatment, motif, and type scale intact.
function applyProjectPalette(style, projectInstructions) {
  const palette = extractHexPalette(projectInstructions);
  if (palette.length < 2) return { ...style };

  return {
    ...style,
    accent: palette[0],
    accent2: palette[1],
    projectPalette: palette
  };
}

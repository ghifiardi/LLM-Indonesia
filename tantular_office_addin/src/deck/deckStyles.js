// Tantular Deck Studio — design system routes.
// Each style is a token set the deterministic compiler uses to lay out slides.
// Colors are hex strings accepted by the PowerPoint JavaScript API.

export const STYLES = {
  executive_cyber: {
    id: "executive_cyber",
    label: "Executive Cybersecurity",
    hint: "Navy boardroom deck, teal/magenta accents.",
    bg: "#0B1F3A",
    panel: "#12294A",
    panelAlt: "#173463",
    accent: "#17B0A6",
    accent2: "#E5237E",
    title: "#F5F8FC",
    text: "#E4ECF7",
    muted: "#9DB2CE",
    onAccent: "#04121F",
    heroBg: "#0A1A31",
    font: "Segoe UI"
  },
  gov_id: {
    id: "gov_id",
    label: "Pemerintah / BUMN (Merah Putih)",
    hint: "Formal Indonesian public-sector report style.",
    bg: "#FFFFFF",
    panel: "#F7EFE1",
    panelAlt: "#F1E2C8",
    accent: "#B4131B",
    accent2: "#C99A2E",
    title: "#1A1A1A",
    text: "#26303B",
    muted: "#6B7480",
    onAccent: "#FFFFFF",
    heroBg: "#B4131B",
    font: "Segoe UI"
  },
  startup_pitch: {
    id: "startup_pitch",
    label: "Startup Pitch",
    hint: "Bold modern cards, high contrast.",
    bg: "#0F1118",
    panel: "#181B26",
    panelAlt: "#222636",
    accent: "#6C5CE7",
    accent2: "#00D1B2",
    title: "#FFFFFF",
    text: "#E7E9F2",
    muted: "#A2A8BE",
    onAccent: "#0B0C12",
    heroBg: "#121420",
    font: "Segoe UI"
  },
  training: {
    id: "training",
    label: "Training / Sekolah",
    hint: "Friendly, clean, instructional.",
    bg: "#FFFFFF",
    panel: "#EAF2FF",
    panelAlt: "#DCEBFF",
    accent: "#2D7FF9",
    accent2: "#12B886",
    title: "#10233F",
    text: "#233247",
    muted: "#66768A",
    onAccent: "#FFFFFF",
    heroBg: "#2D7FF9",
    font: "Segoe UI"
  },
  consulting: {
    id: "consulting",
    label: "Consulting Strategy",
    hint: "Structured, crisp, matrix-friendly.",
    bg: "#FFFFFF",
    panel: "#F0F3F7",
    panelAlt: "#E3E9F1",
    accent: "#1F6FEB",
    accent2: "#0E2A47",
    title: "#0E2A47",
    text: "#22303F",
    muted: "#657084",
    onAccent: "#FFFFFF",
    heroBg: "#0E2A47",
    font: "Segoe UI"
  }
};

export const DEFAULT_STYLE = "executive_cyber";

export function getStyle(styleId, projectInstructions = "") {
  const base = STYLES[styleId] || STYLES[DEFAULT_STYLE];
  return applyProjectPalette(base, projectInstructions);
}

export function styleOptions() {
  return Object.values(STYLES).map((s) => ({ id: s.id, label: s.label, hint: s.hint }));
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

function applyProjectPalette(style, projectInstructions) {
  const palette = extractHexPalette(projectInstructions);
  if (palette.length < 2) return { ...style };

  // Use the user's palette as the main visual system while keeping readability.
  // For bright/high-impact brand colors, white backgrounds with strong accent
  // bands tend to be clearer for executive decks than full-saturated canvases.
  return {
    ...style,
    bg: "#FFFFFF",
    panel: "#F7F8FA",
    panelAlt: palette[2] || "#F2F4F7",
    accent: palette[0],
    accent2: palette[1],
    accent3: palette[2] || palette[0],
    accent4: palette[3] || palette[1],
    accent5: palette[4] || palette[0],
    title: "#1F2933",
    text: "#26303B",
    muted: "#667085",
    onAccent: "#FFFFFF",
    heroBg: "#FFFFFF",
    projectPalette: palette
  };
}

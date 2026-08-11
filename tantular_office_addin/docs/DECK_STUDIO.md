# Tantular Deck Studio

Deck Studio turns a raw brief, pasted text, or selected slide text into a
multi-slide, professionally designed PowerPoint deck — generated directly via
the PowerPoint JavaScript API, fully local.

## Recommended model

Do not use `tantular:0.2-id-3b-lora` for long deck planning. Its fine-tuning is
for short customer-service/safety answers and its runtime profile caps output at
220 tokens. Create the Office/deck profile once:

```bash
npm run model:office
```

Then use:

```text
Model umum / chat: qwen3.5:9b (or another local model)
Model deck: tantular-office:0.4-9b
```

The deck model is routed separately, so a small support model can still be used
for narrow tasks without limiting a 20-slide plan.

Instruction-style prompts such as “Buatlah presentasi dua puluh slide...” are
recognized as briefs rather than mistaken for a one-line title. Explicit slide
counts in Indonesian or numeric form are also honored automatically.

## Flow

```text
Brief / pasted text / selected slide
  -> Tantular plans a DeckSpec (story + slide types)     [deckPlanner.js]
  -> User previews the slide plan in the task pane
  -> Deterministic compiler builds designed slides       [deckCompiler.js]
  -> New slides appended to the current presentation
```

The model is responsible only for **structure and wording**. Visual quality is
produced deterministically by the compiler using a design token system
(`deckStyles.js`), so output looks consistent regardless of model quality.

## Why this split

Small SLMs are unreliable at layout/design and often emit slightly malformed
JSON. Deck Studio isolates those risks:

- `deckPlanner.js` extracts and **repairs** JSON (fenced blocks, trailing
  commas, stray/missing brackets) and falls back to a deterministic outline if
  the model output is unusable.
- `deckCompiler.js` never trusts the model for pixels — it maps slide types to
  hand-built layouts.

## Slide types

| Type | Layout |
|---|---|
| `title` | Hero slide with accent band |
| `agenda` / `bullets` / `closing` | Accent-bulleted content list |
| `cards` | Responsive card grid (up to 8) |
| `columns` | 1–3 comparison columns |
| `metrics` | Up to 4 big-number stat cards |
| `quote` | Full-bleed key message |

## Design routes (`deckStyles.js`)

- `executive_cyber` — navy boardroom, teal/magenta accents
- `gov_id` — Indonesian public-sector red/gold
- `startup_pitch` — bold dark, high contrast
- `training` — clean, friendly, instructional
- `consulting` — structured, matrix-friendly

## Usage in the task pane

1. Paste your brief into **Teks / seleksi** (or click **Ambil seleksi**).
2. In **✨ Deck Studio**, choose a design style and slide count.
3. Click **1 · Susun rencana** to generate and preview the plan.
4. Click **2 · Buat deck** (PowerPoint only) to build the slides.

## Limits / next steps

- Canvas assumes 16:9 (960×540 pt).
- Document upload (.docx/.pdf) and image/screenshot OCR are planned as
  companion-app inputs, not task-pane-only.
- Redesigning an existing deck in place is a later milestone.

## Revamp current slide

Build: `0.4.0-revamp-slide`

The task pane includes **Revamp slide** for PowerPoint:

1. Select the slide thumbnail you want to improve.
2. Click **Revamp slide**.
3. Tantular attempts to read text boxes from the selected slide via PowerPoint JS.
4. If text is available, it creates a redesigned mini-deck plan.
5. Click **Buat deck** or **Download .pptx**.

If the current slide is a screenshot/image with no editable text, Office.js may
not expose the text. In that case, paste the slide text/description into
**Teks / seleksi** and click **Revamp slide** again. The next planned companion
feature is OCR/vision extraction for screenshot-heavy slides.

## Extract from image (OCR/vision)

Build: `0.5.0-vision-extract`

For screenshot/image-heavy slides, use **Extract from image**:

1. Install a local Ollama vision model, for example:
   ```bash
   ollama pull llama3.2-vision
   ```
2. In Tantular settings, set **Model vision** to that model name.
3. Upload a PNG/JPG screenshot of the slide/diagram.
4. Click **Ekstrak teks dari gambar**.
5. The extracted structured text is placed into **Teks / seleksi**.
6. Click **Revamp slide** or **Susun rencana**.

If no vision model is installed, the add-in will show a message such as:
`Model vision "llama3.2-vision" belum ada di Ollama. Jalankan: ollama pull llama3.2-vision`.

## Simplified flow (0.6.0-one-click)

Deck Studio now has just two buttons:

- **✨ Buat Deck** — one click. It resolves the source automatically, plans the
  deck, and creates it. In PowerPoint it inserts slides (or opens a new
  presentation if the host rejects insertion); outside PowerPoint it downloads.
- **Download .pptx** — same resolution, but always outputs a file.

### Automatic source priority

1. Uploaded image/screenshot (OCR/vision, extracted once per file)
2. Text in the **Teks / seleksi** box
3. The currently selected slide's text

### Automatic planning priority

1. Capability-map parser (for domain/status screenshots)
2. Single clean title slide (when only a title is readable)
3. Model deck plan (general briefs)

No more separate "Susun rencana" / "Revamp slide" / "Buat deck" steps.

## Freeform Project / Output Instructions (0.7.0)

Deck Studio now supports a saved freeform project spec. Paste any style guide,
brand palette, chart preference, output format, or methodology requirements into
**Project / output instructions (bebas)** and click **Simpan instruksi**.

The instructions are used by:

- image OCR/vision extraction context,
- model deck planning,
- deterministic output-format enforcement,
- PPTX rendering palette.

If the instructions contain hex colors, Deck Studio extracts them and applies the
palette to generated slides. Example:

```text
This project is for creating interactive data visualization comparing industry
best practices with our Security Operation Center.

Brand colors:
#EC008C, #24BDAD, #FFCB09, #C7158D, #EE1C24

- Favor bar charts for comparisons, line charts for trends, and heat maps for geographic data.
- Include clear titles, legends, and data labels.
- Design for readability at executive presentation level.

Output format:
1. Interactive artifacts
2. Always include brief 3-5 bullet executive summary of key insight
3. Short methodology notes on data sources used
```

Notes:
- In PowerPoint output, “interactive artifacts” are represented as visualization
  slides/static artifacts. A future HTML artifact export can make them truly
  interactive.
- If executive summary or methodology notes are requested, Deck Studio inserts
  those slides when the model does not create them itself.

## Document / PDF input (0.8.0)

Deck Studio can now use documents as a source, not only screenshots.

Supported:

- TXT / Markdown / CSV / JSON: extracted directly in the task pane
- DOCX: extracted by the local Python companion using standard-library ZIP/XML
- PDF: extracted by the local Python companion when `pypdf`, `PyPDF2`, or the
  `pdftotext` command is installed

Start the local document extractor in a separate terminal:

```bash
cd godel_agent_prototype/tantular_office_addin
npm run doc-server
```

Then in Deck Studio, choose a file under **Sumber dokumen/PDF (opsional)** and
click **Buat & Download Deck**. Source priority is:

1. Document/PDF upload
2. Image/screenshot upload
3. Text in the source box
4. Selected slide text

If PDF extraction fails, install one extractor option, for example:

```bash
python3 -m pip install pypdf
# or install poppler/pdftotext via your package manager
```

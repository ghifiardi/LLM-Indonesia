# Tantular Office

Indonesian-first productivity model powering the **Tantular Office add-in**
(local/private AI for Word, Excel, and PowerPoint). Built on **Qwen3** with an
Office-tuned runtime profile: 32k context, long structured output (up to
30-slide deck plans), low temperature, and strict source-grounding — it will
not invent numbers, sources, or benchmarks that aren't in your material.

## Tags

| Tag | Base | Size | Minimum comfortable RAM |
|---|---|---|---|
| `latest` / `0.3-8b` | Qwen3 8B | ~5 GB | 16 GB |
| `lite` | Qwen3 4B | ~2.5 GB | 8 GB |

**Under 12 GB RAM, use `lite`** — the 8B model swaps to disk and times out.
Deck quality on `lite` is a step below 8B but still produces properly
structured decks.

## Usage

```
ollama pull ghifidanukusumo/tantular        # 16 GB+ machines
ollama pull ghifidanukusumo/tantular:lite   # 8 GB machines
```

Then in the Tantular Office task pane → **Pengaturan model lokal** → set
**Model Studio** to the tag you pulled → Simpan → Tes model terpilih.

Works standalone too: `ollama run ghifidanukusumo/tantular`

## What it's tuned for

- Deck Studio: brief → multi-slide deck plan (title, agenda, bullets, cards,
  columns, metrics, quote, visualization, closing)
- Document/Sheet Studio: structured DOCX/XLSX plans as valid JSON
- Slide copy: concise, one main idea per slide, executive tone
- Answers in clear professional Bahasa Indonesia (other languages on request)

## Limitations

- A runtime profile for Office tasks, separate from the
  customer-service/digital-safety LoRA variant
- Source-grounded by design: if your material lacks data, it flags
  "perlu validasi" instead of fabricating facts
- First call after startup includes model load — allow extra time

Base model: Qwen3 (Apache 2.0).

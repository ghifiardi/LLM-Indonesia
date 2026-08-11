# Local Model Performance, Limits, and Expectations

Reference for facilitators and support staff running Tantular Office on participant
laptops. Explains the most common failure participants hit ("Buat Deck seems to loop
endlessly"), why it happens, how to fix it in two minutes, and what to promise people
about their own hardware.

## The "endless loop" symptom

What participants report: they click **Buat Deck**, nothing happens for minutes, they
click again, and the add-in appears to loop forever without producing a deck.

What is actually happening — there is no loop in the code:

1. Each **Buat Deck** click sends one request to the local companion (Ollama) with an
   **8-minute budget** (`timeoutMs: 480_000` for Studio tasks).
2. On an under-provisioned laptop the 9B model cannot finish generation inside that
   budget. The request is aborted and the pane shows:
   *"Permintaan model lokal terlalu lama. Coba lagi setelah model selesai dimuat, atau
   pilih model yang lebih cepat."*
3. The request then falls back to the smaller chat model, which produces a weaker
   result — or fails too.
4. Every extra click made *while waiting* queues another request behind the stuck one.
   Ollama serves them serially, so each retry makes the machine slower, not faster.

That queue-behind-a-stuck-request behaviour is what reads as "looping endlessly".

**Root cause is almost always RAM, not the add-in or Ollama.** The 9B model is roughly
6.6 GB of weights. If it does not fit in physical memory the OS swaps it to disk, and
token generation drops from tens of tokens/second to a fraction of one.

Quick check on Windows: **Task Manager → Performance → Memory**. On macOS:
**Activity Monitor → Memory**, or `sysctl -n hw.memsize`.

| Installed RAM | 9B model verdict |
|---|---|
| 16 GB or more | Full 9B experience, works as designed |
| 12–16 GB | Usable but slow; close other apps |
| Under 12 GB | Painful — use the lite model |
| Under 8 GB | Effectively unusable with 9B |

## Immediate fix on an affected machine (~2 minutes)

1. **Quit Ollama from the system tray and start it again.** This clears the stuck
   request queue — without this step the next steps still feel slow.
2. In a terminal / PowerShell:
   ```
   TANTULAR_OFFICE_BASE_MODEL=qwen3.5:4b \
   TANTULAR_OFFICE_MODEL_NAME=tantular-office:lite \
   npm run model:office
   ```
   (~3.4 GB, Qwen3.5-4B base with the Tantular Office profile, suitable for an
   8 GB machine when other applications are kept light.)
3. In the Tantular pane → **Pengaturan model lokal** → set **Model Studio: deck / DOCX /
   XLSX** to `tantular-office:lite` → **Simpan** → **Tes model terpilih**. It
   should now respond in seconds.
4. Click **Buat Deck once** and wait. **Do not re-click while the spinner is running** —
   that is what builds the queue.

## Installer behaviour (workshop package)

Both installers pull the official Qwen3.5 base from Ollama, apply the local
Office profile, and select the base according to installed RAM:

- `tools/install-office-model.sh` (macOS) reads `sysctl -n hw.memsize`
- `tools/install-office-model.ps1` (Windows) reads total physical memory

Below **12 GB** they skip the 9B entirely and pull the light variant:

| Machine | Base pulled | Local alias / Model Studio field |
|---|---|---|
| ≥ 12 GB RAM | `qwen3.5:9b` | `tantular-office:0.4-9b` |
| < 12 GB RAM | `qwen3.5:4b` | `tantular-office:lite` |

The generated model uses the local alias the add-in expects. When the lite path is
taken the installer prints the model tag the participant must enter in the
**Model Studio** field. Setting `TANTULAR_OFFICE_BASE_MODEL` explicitly overrides
auto-detection; `TANTULAR_OFFICE_REGISTRY_MODEL` opts into a prebuilt registry source.

The workshop support page (`workshop/support.html`) carries a troubleshooting entry for
this exact symptom, including the "don't click Buat Deck repeatedly" warning.

## Timeout budgets by task

Useful when diagnosing which call timed out (`src/tantularClient.js`):

| Call | Budget | Model used |
|---|---|---|
| Studio tasks (`deck`, `document`, `workbook`) | 480 s | Model Studio (9B / lite) |
| General chat | 90 s | chat model |
| Vision | 180 s | vision model |
| **Tes model terpilih** connection check | 180 s | selected model |

A first call after startup includes cold-start model load, so it is legitimately the
slowest one of a session. Wait it out before concluding anything is broken.

## What to expect from each model

| | `tantular-office` (9B) | `tantular-office:lite` (4B) |
|---|---|---|
| Weights on disk | ~6.6 GB | ~3.4 GB |
| Minimum comfortable RAM | 16 GB | 8 GB |
| Deck structure and section flow | Best | Good — proper structured decks |
| Nuance, phrasing, long-document reasoning | Stronger | A step below |
| Risk of Studio timeouts | High under 12 GB RAM | Low |

Deck quality on 4B is a step below 9B but still produces properly structured decks —
vastly better than timeouts and fallbacks.

## For the facilitator checklist

Put this line on the workshop invitation so participants know what their own laptop
will give them:

> **16 GB RAM → full 9B experience. 8 GB RAM → lite model, still works.**
> Below 12 GB the installer automatically switches to `tantular-office:lite`.

And in the room, one rule worth saying out loud before the first exercise:

> Click **Buat Deck** once and wait for the spinner. Clicking again does not speed it
> up — it queues another request and slows the machine down.

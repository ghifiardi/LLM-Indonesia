# Tantular Office Add-in MVP Plan

## Product thesis

Tantular is the private, Indonesian-first Office assistant for organizations that cannot or do not want to send documents to cloud AI. It should complement the Android/message-safety wedge while extending Tantular into daily productivity surfaces.

## Supported Office hosts

This MVP uses one Office.js task-pane add-in manifest for:

| Host | MVP role | Why it matters |
|---|---|---|
| Word | Indonesian writing helper + document safety | Strongest fit after Outlook because document text access and rewrite workflows are natural. |
| Excel | Text classification and formula explanation | Differentiated when used for transaction/customer-message columns; avoid positioning as a numeric analyst. |
| PowerPoint | Slide text cleanup and notes drafting | Useful, but intentionally narrow because full design/deck generation is beyond a small SLM MVP. |

Outlook remains the strongest identity wedge for scam-checking, but it should be packaged either as a separate mail add-in manifest or as a future unified Microsoft 365 app package after platform compatibility is confirmed.

## MVP feature set by app

### Word

1. **Perbaiki bahasa**
   - Input: selected text.
   - Output: cleaner Bahasa Indonesia while preserving meaning.
   - Modes: formal, santai, concise.
2. **Rapikan draf**
   - Input: selected paragraph/section.
   - Output: improved letter, memo, or report wording.
3. **Ringkas bagian**
   - Input: selected section.
   - Output: bullet summary in Indonesian.
4. **Cek penipuan / surat mencurigakan**
   - Input: pasted or selected text.
   - Output: 🛑/⚠️/✅ risk level, reasons, and safe next steps.

### Excel

1. **Jelaskan formula**
   - Input: selected formula cell.
   - Output: plain-language Indonesian explanation.
2. **Buat formula sederhana**
   - Input: user description.
   - Output: candidate Excel formula plus caveats.
3. **Klasifikasi teks per baris**
   - Input: selected one-column range of transaction descriptions, complaints, or customer messages.
   - Output: adjacent labels such as `🛑 Risiko tinggi`, `⚠️ Perlu dicek`, `✅ Aman/normal`, plus short reason.
   - MVP cap: 50 rows per run.
4. **Bersihkan teks**
   - Input: selected text cells.
   - Output: standardized capitalization, spacing, and common Indonesian formatting.

### PowerPoint

1. **Paragraf → bullet slide**
   - Input: selected/pasted paragraph.
   - Output: 3-6 concise Bahasa Indonesia bullets.
2. **Pendekkan teks slide**
   - Input: selected slide text.
   - Output: shorter on-slide copy.
3. **Draft speaker notes**
   - Input: selected slide text.
   - Output: presenter notes in Indonesian.

## Non-goals for MVP

- No full automatic deck design.
- No 40-page Word document summarization in one request.
- No 10,000-row Excel scanning.
- No claim that the model is always mathematically correct.
- No cloud inference by default.

## Architecture

```text
Word / Excel / PowerPoint task pane
  -> Office.js read selected text/range
  -> prompt builder with host + feature constraints
  -> local companion API on 127.0.0.1
  -> Tantular small Indonesian SLM
  -> deterministic post-processing for labels/safety formatting
  -> explicit user click to insert/write result
```

## Rollout order

1. **Outlook** — scam check, strongest brand identity.
2. **Word** — writing help and document safety.
3. **Excel** — batch text classification, most differentiated Office feature.
4. **PowerPoint** — useful polish, but narrow and last.

## Success metrics

- First-token latency and full response latency for short selections.
- User acceptance rate for Word rewrites.
- Precision/recall on Excel row labels for scam/complaint/transaction text.
- Number of avoided cloud uploads for privacy-sensitive documents.
- Manual QA pass rate for safety-floor responses on OTP/PIN/CVV/APK/remote-access examples.


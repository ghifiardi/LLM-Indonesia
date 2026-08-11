# Tantular Document Studio

Document Studio is the Word/DOCX counterpart to Deck Studio. It turns a brief,
selected text, or the main body of an open Word document into a professionally
structured `.docx`, fully locally.

## Sideload on Word for Mac

The shared manifest must be copied into Word's own add-in folder; installing it
for PowerPoint does not automatically install it for Word:

```bash
npm run sideload:word
```

Then save all open documents and fully quit Word with **Cmd+Q**. Closing only
the document window or clicking the red window button does not terminate Word;
the local `wef` manifests are scanned only when the Word application starts.
Reopen Microsoft Word, open a document, and use:

```text
Home → Tantular → Open Tantular
```

## Model

Document Studio uses the same 9B Office model route as Deck Studio:

```text
Model deck / dokumen: tantular-office:0.4-9b
```

The smaller `tantular:0.2-id-3b-lora` remains suitable for short support/safety
answers but is not recommended for long documents.

## Supported document types

- Professional report
- Proposal
- Executive memo
- Training module
- Policy brief
- Article / white paper
- Meeting notes and action items

## Source priority

1. Text in the shared **Teks / seleksi** box
2. Current Word selection
3. Main Word document body

## Output

The deterministic DOCX builder creates:

- title, subtitle, author/date metadata,
- executive-summary bullets,
- Heading 1 and Heading 2 sections,
- body paragraphs,
- real OOXML bullet numbering,
- quote/callout paragraphs,
- conclusion and next-step sections.

Users can:

- append the generated document to the active Word file,
- explicitly replace the complete Word body, or
- download a standalone `.docx`.

Append is the default so existing content is not destroyed implicitly.

## Architecture

```text
Brief / Word selection / document body
  -> Tantular Office plans a normalized DocumentSpec
  -> JSON mode + deterministic validation/fallback
  -> dependency-free OOXML DOCX builder
  -> insertFileFromBase64 in Word or .docx download
```

The model controls structure and wording. Package validity, Word styles,
numbering, page geometry, and XML escaping are deterministic.

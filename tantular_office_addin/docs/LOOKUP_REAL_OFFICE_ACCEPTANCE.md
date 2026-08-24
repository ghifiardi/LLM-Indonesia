# Lookup: real-Office acceptance gate

Date prepared: **August 24, 2026**

This is the final manual gate before setting `TANTULAR_LOOKUP_ENABLED=true` in
normal workshop or production use. Unit tests and browser mocks are necessary
but cannot prove the behavior of the Office JavaScript proxies shipped by a
particular Word, Excel, or PowerPoint build.

## Automated evidence already complete

- Full pane/controller/Companion path is wired.
- Feature flag remains default-off.
- Real `id.wikipedia.org` lookup completed through the local Companion, local
  `tantular-office:0.5-9b` model, and verifier.
- Seven prompt-injection classes completed through the product HTTP path:
  **7/7 run, 0 reached the user, 0 errors**.
- Node and Python reference verifiers agree, including the hostile-disclaimer
  regression.
- Workshop web and Companion package contain byte-identical lookup modules.
- Office applications detected on this Mac:
  - Word `16.108.1`
  - Excel `16.108.1`
  - PowerPoint `16.108.1`

## Test setup

1. Keep the normal production default unchanged.
2. In a dedicated Companion terminal, start the test session with:

   ```bash
   TANTULAR_LOOKUP_ENABLED=true npm run dev
   ```

3. Confirm locally:

   ```bash
   curl -ks https://localhost:3000/api/lookup/status
   ```

   Expected:

   ```json
   {"enabled":true,"hosts":["id.wikipedia.org"]}
   ```

4. Sideload the current `manifest.xml`, fully quit the Office host, then reopen
   it. Use the existing `npm run sideload:word`, `npm run sideload:excel`, and
   `npm run sideload:powerpoint` helpers as appropriate.
5. Use a generic, non-confidential query during acceptance. The query will leave
   the machine after approval.

## Shared assertions for every host

For every Word, Excel, and PowerPoint run:

1. The lookup row is hidden when the flag is off.
2. With the flag on, the row appears but the toggle is unchecked.
3. Turning on **Mode Lokal + Pencarian** reveals the query input.
4. Clicking **Tinjau query dan cari** shows exactly:
   - host `id.wikipedia.org`;
   - the query typed by the tester;
   - the Office source used for verification;
   - a truncation warning when applicable.
5. Selecting **Batal** produces no execute request and no web lookup.
6. Selecting **Setujui** produces either:
   - **Jawaban terverifikasi**, with an edit button; or
   - **Jawaban ditahan**, with no answer and no edit button.
7. Turning the toggle off clears the result immediately.
8. Switching the processing mode to Cloud causes lookup transport to refuse;
   document text must not be posted to the hosted gateway.

## Word

### Normal document

Create a document containing:

```text
Laporan uji lookup.
Vendor utama PT Sinar Mas.
Pagu Rp 1.750.000.000.
```

Expected:

- source disclosure says `Word: seluruh isi dokumen`;
- the approval binds the complete body text;
- the verified answer, if any, preserves both protected strings.

### Empty document

Expected:

- `empty_document`;
- no `/api/lookup/prepare`;
- no internet request.

### Compatibility Mode

Open a `.doc`/Compatibility Mode document and repeat the normal test. Record the
exact Word build and whether `context.document.body.load("text")` succeeds.

## Excel

### Selected range

Create and select:

| Vendor | Pagu |
|---|---:|
| PT Sinar Mas | 1750000000 |

Expected:

- disclosure identifies the selected address;
- only the selected cells appear in the local document payload;
- unselected sheets/cells are absent.

### Empty selection

Select blank cells.

Expected:

- `empty_selection`;
- no prepare or execute request.

### Multi-area or cross-sheet selection

Attempt the host's supported multi-selection behavior.

Expected:

- either a correct, explicitly identified selection is read; or
- `read_failed` with the Office API reason.

It must never silently substitute the entire workbook or an empty string.

## PowerPoint

### Selected text slide

Select one slide containing:

```text
Vendor PT Sinar Mas
Pagu Rp 1.750.000.000
```

Expected:

- disclosure says one selected slide;
- text is available only after the host completes
  `textRange.load("text")` and `context.sync()`;
- the protected strings reach the verifier.

### Slide without text

Select an image-only slide.

Expected:

- `empty_selection`;
- no prepare or execute request.

### Host without `getSelectedSlides`

On an older host, if available:

- show `host_unavailable`;
- do not guess the active slide;
- do not read the entire presentation.

## Long-document disclosure

Use a Word document or selected range longer than 200,000 characters.

Expected:

- approval explicitly says the document was truncated;
- the same truncated bytes are used for prepare and execute;
- the UI never describes the result as checked against the complete document.

## Evidence record

Complete one row per run:

| Host | Office version/build | OS | Source case | Approval exact | Cancel = no execute | Verdict | Toggle clears | Pass |
|---|---|---|---|---|---|---|---|---|
| Word | | | normal / empty / compatibility | | | | | |
| Excel | | | range / empty / multi-area | | | | | |
| PowerPoint | | | text / image-only / old host | | | | | |

Attach screenshots of:

1. toggle and query entry;
2. approval dialog showing host and query;
3. verified and blocked states;
4. any Office API error message.

## Activation decision

Enable lookup for normal users only when:

- the normal Word, Excel, and PowerPoint cases pass in real Office;
- empty/unsupported cases fail before prepare;
- cancellation is observed to make no execute request;
- no blocked answer or hostile payload literal reaches the pane;
- the operator accepts that the approved query itself leaves the machine.

If any condition fails, leave `TANTULAR_LOOKUP_ENABLED` unset/false. No code
change is required to roll back; the default remains off.

# Excel chat: local analytics

The Excel chat answers statistics questions about the open workbook entirely
inside the task pane. The workbook's cells are read, analysed by the vendored
Tantular data-studio engine (`src/vendor/tantular-dashboard/stats.mjs`, see its
`PROVENANCE.md`), and shown in the chat. No model is called for these turns and
no request leaves the pane — not to Ollama, not to the companion, not to Mode
Cloud.

## What it does

| Ask (examples) | Tool (upstream name) | Shows |
| --- | --- | --- |
| "statistik deskriptif", "rata-rata Pendapatan per Region" | `statistics` | n, empty cells, mean, median, sample std, quartiles, min/max, IQR outliers, skewness; per group when asked |
| "korelasi Diskon dan Pendapatan", "korelasi antar kolom" | `correlate` | Pearson r (+ p), Spearman ρ, strength; yes/no columns read as 1/0 |
| "bandingkan Pendapatan per Region", "uji t … berdasarkan Kanal" | `compare_groups` | per-group summary; Welch t + Mann–Whitney (2 groups) or ANOVA + Kruskal–Wallis (3–10); chi-squared of proportions for a yes/no outcome |
| "tren Pendapatan bulanan", "tren jumlah transaksi" | `time_series` (+ `linear_trend` on the periods) | sum/avg/count per day/week/month, moving average, period change, anomalies, overall change, linear trend |

## Which cells

1. A selection of two or more rows; else
2. the Excel table under the cursor (ExcelApi 1.9); else
3. the active sheet's used range.

The header is the first full text row among the top ten (a title row above it
is skipped and reported). Excel date serials with a date format become ISO
dates; booleans read as true/false; error cells are empty; a trailing
TOTAL/Jumlah row is left out. Typing otherwise follows upstream `parseCSV`
(leading-zero codes stay text). Limits: 10,000 data rows, 50 columns.

## Clarification

Routing and column resolution are deterministic (`src/chat/analysisIntent.js`).
When the intent or columns are unclear the chat asks one question with the
table's own column names as chips — e.g. "Korelasikan "Pendapatan" dengan kolom
mana?". Answers accumulate onto the original request; "batal" cancels. Chart,
formula and editing requests ("buat chart …", "tambahkan kolom …") stay with the
existing planner. Prefix a message with `/analisis` to force the local path.

## Saving results

Results are shown first. "Simpan hasil ke sheet baru" re-reads the analysed
cells and refuses if they changed, then opens the normal review card for one
`add_sheet` action; "Terapkan" re-checks the source again before writing.
Result text that starts like a formula is written as text.

## Privacy notes

- The model history records only neutral markers for analytics turns
  ("Hasil analisis … ditampilkan di panel"), never figures or headers.
- Voice turns use the same path; the spoken reply is a short local summary.
  The voice locality guards are unchanged.

## Not yet

Filters ("hanya Jakarta"), campaign/event windows, cost efficiency, churn and
program-effect tools exist in the engine but are not wired. Free-text dates
like "01/10/2026" are not parsed as dates. Messages are matched by keyword, so
unusual phrasing may need `/analisis` or a clarification round.

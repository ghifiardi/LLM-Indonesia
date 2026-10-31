# Vendored: Tantular data-studio statistics engine

`stats.mjs` in this folder is an unmodified copy. Do not edit it here; change it
upstream and re-vendor, then update the hash below
(`tests/analysisVendor.test.mjs` fails if the copy drifts).

| Field | Value |
| --- | --- |
| Upstream repository | `ghifiardi/tantular-landing` (private) |
| Commit | `0f87a306e6932173112e126d0eb89f0259653624` (2026-10-31, "Model audit harness (measurement only) … (#107)") |
| Upstream path | `public/dashboard/stats.mjs` |
| SHA-256 | `d53cabe2981f189dff56af762fb4b978ce3e26e2b91e921c2e0e71f78a339b43` |
| Vendored on | 2026-10-31 |
| Author | ghifiardi (same owner as this add-in) |

## Licensing

The upstream repository has no top-level license file and is private; the
engine is the owner's own code, reused here by the owner. The Apache-2.0
`LICENSE` in upstream `local-dashboard/reference/` covers only the third-party
"Data 1.1.0" reference skill text, which upstream's own
`local-dashboard/reference/provenance.json` describes as reference material
("runtime tools are implemented separately"). No part of that reference
material is copied into this add-in. If the add-in is ever distributed under an
open license, add an explicit license grant for this file first.

## Related upstream files (not vendored)

- `public/dashboard/core.mjs` — CSV reader (`parseCSV`), tool dispatch
  (`callTool`). Not copied: it imports DuckDB, SQL-gate and dashboard modules
  the add-in does not have. `src/chat/analysisTable.js` re-implements the one
  piece the add-in needs — the `{ columns, types, rows }` table shape and
  `parseCSV`'s typing rules — for Excel ranges instead of CSV text.
- `tests/dashboard-stats.test.mjs` — reference tests. The pure-statistics
  cases (textbook / SciPy reference values) are ported to
  `tests/analysisVendor.test.mjs` and run against this copy.

## What the add-in uses

`statisticsTool`, `correlateTool`, `compareGroupsTool`, `timeSeriesTool`,
`linearTrendTool` and `pPhrase`. Everything runs inside the task pane on rows
already read from the open workbook: no network, no model call.

# Fix B: live mini-probe -- reject-reason evidence for weak prose strata

## Method
`tantular/finetune/.venv/bin/python` + real Tinker teacher
(`TinkerProseTeacher`, model `Qwen/Qwen3.5-397B-A17B`), sourced via
`set -a && . ~/.tantular-tinker.env && set +a`. Ran `generate_prose` directly
(bypassing `run_pilot`, to get verbatim rejected outputs, not just counts)
for the three weak strata -- `prose:terjemah`, `prose:ringkas`,
`prose:tanyaDokumen` -- 10 candidates each, against the real
`prose:<pipeline>` production system prompt (via `BridgeClient.dump_prompts`)
and the same train-split family `pilot._pilot_families(seed=0)` picks.
Driver script: one-off, not committed (`.superpowers/sdd/fix-b-probe.md` is
the durable record; re-derivable from `gen_prose.generate_prose` +
`pilot._pilot_families` directly).

## BEFORE tuning

| pipeline | accepted/10 | reject_reasons |
|---|---|---|
| terjemah | 2 | `{"near_duplicate": 8}` |
| ringkas | 2 | `{"near_duplicate": 8}` |
| tanyaDokumen | 4 | `{"near_duplicate": 6}` |

**Finding: every single reject across all three strata was `near_duplicate`
-- zero `format_invalid`, zero `length_invalid`, zero `cjk_leakage`.** None
of the three original suspects (commentary-wrapper filter, bullet-format
filter, length caps/elicitation) fired even once. The task brief's
hypotheses were reasonable but wrong for this batch of live data.

Root cause: `terjemah`/`ringkas`/`tanyaDokumen` are near-deterministic tasks
-- translating / summarizing / answering-over the SAME fixed source text
yields near-identical teacher output draw after draw (translation of one
sentence has essentially one correct rendering; summarizing one fixed
paragraph into bullets has little room to vary). `_pick_seed` chose from only
a 2-entry seed bank per pipeline (`hashlib.sha256(f"{family_id}:{i}") % 2`),
so across 10 candidates each seed got picked ~5x, and repeat-seed draws then
collided with `dedup.near_duplicates` (`threshold=0.8`) within the batch --
correctly rejected, since they genuinely were near-duplicate outputs, but
the seed bank was too thin to generate 10 genuinely-different candidates.

Verbatim rejected samples (2-3 per stratum):

**terjemah** (all `near_duplicate`):
```
"Pendapatan perusahaan naik 12 persen pada kuartal kedua tahun ini." -> Terjemahkan ke Bahasa Inggris.
  -> "The company's revenue increased by 12 percent in the second quarter of this year.<|im_end|>"
  -> "The company's revenue increased by 12 percent in the second quarter of this year.<|im_end|>"  (repeat)

"Company revenue increased by 12 percent in the second quarter." -> Terjemahkan ke Bahasa Indonesia.
  -> "Pendapatan perusahaan meningkat sebesar 12 persen pada kuartal kedua.<|im_end|>"
```

**ringkas** (all `near_duplicate`):
```
[laporan kuartalan seed] -> "- Pendapatan kuartal kedua naik 12 persen.\n- Biaya operasional turun berkat
  efisiensi di seluruh cabang.\n- Manajemen menargetkan pertumbuhan berkelanjutan pada kuartal berikutnya
  dengan fokus efisiensi biaya.<|im_end|>"  (repeated verbatim across draws of the same seed)

[rapat peluncuran produk seed] -> "- Rapat membahas rencana peluncuran produk baru pada bulan depan.\n-
  Tim pemasaran bertugas menyiapkan materi promosi.\n- Tim produksi memastikan ketersediaan stok yang
  cukup.\n- Tim penjualan menyiapkan target untuk setiap cabang.<|im_end|>"
```

**tanyaDokumen** (all `near_duplicate`):
```
[cuti tahunan seed] -> "Berdasarkan konteks dokumen yang diberikan, setiap karyawan berhak atas **12
  hari** cuti per tahun.<|im_end|>"

[reimbursement seed] -> "Batas waktu pengajuan reimbursement adalah **14 hari kerja** sejak transaksi
  dilakukan.\n\nHal ini didasarkan pada konteks dokumen yang menyatakan bahwa karyawan wajib mengajukan
  bukti pengeluaran dalam jangka waktu tersebut agar dapat disetujui oleh atasan langsung.<|im_end|>"
  -> near-identical two-sentence variant on the next draw of the same seed
```

(Note, separate from the reject-reason finding: every raw completion carries
a trailing `<|im_end|>` control-token artifact from `TinkerProseTeacher`'s
decode -- doesn't trip any current filter, so it isn't blocking acceptance,
but it's a data-quality smell worth a follow-up; see report's Concerns.)

## Tuning applied
`tantular/finetune/gen_prose.py`: widened the `_SEEDS` bank for the three
near-deterministic pipelines only (2 -> 6 distinct seeds each for `terjemah`
and `tanyaDokumen`, 2 -> 6 for `ringkas`), so a 10-candidate batch has far
fewer same-seed collisions (and therefore far fewer genuine repeat-output
near-duplicate rejects). No change to `format_ok`, `_has_commentary_wrapper`,
or `_LENGTH_CAPS` -- the live evidence showed those filters were never the
problem for this batch, so per the brief's "MINIMAL tuning" instruction they
were left untouched rather than "fixed" speculatively.

## AFTER tuning (mini-probe re-run, same method, one iteration)

| pipeline | accepted/10 | reject_reasons |
|---|---|---|
| terjemah | 6 | `{"near_duplicate": 4}` |
| ringkas | 5 | `{"near_duplicate": 5}` |
| tanyaDokumen | 7 | `{"near_duplicate": 3}` |

Before -> after acceptance: terjemah 2/10 -> 6/10, ringkas 2/10 -> 5/10,
tanyaDokumen 4/10 -> 7/10. All remaining rejects are STILL
`near_duplicate` (still zero format/length/CJK rejects) -- consistent with
the diagnosis: even a 6-seed bank drawn 10x still has expected repeats
(birthday-paradox arithmetic: ~10/6 draws per seed), just far fewer than a
2-seed bank. Widening further would trade off against the seed bank being a
hand-authored, "realistic scenario" bank (see module docstring) rather than
templated/generated seeds -- left at 6 per the brief's two-iteration cap;
diminishing-but-still-positive returns from widening further is a natural
follow-up, not done here.

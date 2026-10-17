// 2026-08-31 screenshot regression: the user reported a real financial PDF
// converted through Document Studio into a Word memo where every section was
// "Bagian N", the executive summary was generic, and the bilingual cover
// page ("PT MERDEKA COPPER GOLD Tbk", "DAN ENTITAS ANAK/AND ITS
// SUBSIDIARIES", ...) became five unrelated paragraphs instead of a
// recognized title.
//
// This is a SYNTHETIC fixture built to match the shape of that report (the
// same bilingual cover fields, the same statement-heading vocabulary, the
// same [Page N] flattened-extraction format tools/document-extractor.py
// already produces) — not the user's actual file, which was never provided,
// only a screenshot. It forces the model path to return invalid JSON so the
// deterministic fallback (planDocument's invalid_json branch ->
// fallbackDocumentSpec -> buildDeterministicDocumentSpec) is what actually
// runs, end to end, exactly as it would for a real invalid/failed model
// response on this kind of source.
//
// This test MUST fail against the pre-fix fallbackSections() (which only
// ever produces "Bagian N" headings) and pass against the current
// buildDeterministicDocumentSpec().

import test from "node:test";
import assert from "node:assert/strict";
import { planDocument } from "../src/document/documentPlanner.js";
import { buildDocumentDocxBase64 } from "../src/document/docxBuilder.js";

// Mirrors the exact fields from the user's screenshot, plus representative
// statement rows so financial-row/period association can be checked. Kept
// short but realistic: a title page, a repeated header/footer line, and two
// statement sections with numeric rows.
const SCREENSHOT_LIKE_FIXTURE = [
  "[Page 1]",
  "PT MERDEKA COPPER GOLD Tbk",
  "DAN ENTITAS ANAK/AND ITS SUBSIDIARIES",
  "LAPORAN KEUANGAN KONSOLIDASIAN INTERIM/",
  "INTERIM CONSOLIDATED FINANCIAL STATEMENTS",
  "31 MARET 2026 DAN 31 DESEMBER 2025/",
  "31 MARCH 2026 AND 31 DECEMBER 2025",
  "LAPORAN AUDITOR INDEPENDEN/",
  "INDEPENDENT AUDITOR'S REPORT",
  "Dinyatakan dalam ribuan Dolar AS, kecuali dinyatakan lain.",
  "PT Merdeka Copper Gold Tbk - Laporan Keuangan Interim",
  "[Page 2]",
  "PT Merdeka Copper Gold Tbk - Laporan Keuangan Interim",
  "LAPORAN POSISI KEUANGAN/",
  "STATEMENT OF FINANCIAL POSITION",
  "kas dan setara kas 91,003 18,478 cash and cash equivalents",
  "piutang usaha 45,210 39,880 trade receivables",
  "persediaan 120,554 98,332 inventories",
  "PT Merdeka Copper Gold Tbk - Laporan Keuangan Interim",
  "[Page 3]",
  "PT Merdeka Copper Gold Tbk - Laporan Keuangan Interim",
  "LAPORAN LABA RUGI/",
  "PROFIT OR LOSS",
  "pendapatan bersih 512,300 470,110 net revenue",
  "beban pokok pendapatan (301,200) (289,004) cost of revenue",
  "laba bruto 211,100 181,106 gross profit",
  "PT Merdeka Copper Gold Tbk - Laporan Keuangan Interim"
].join("\n");

function forceInvalidJsonFetch() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '{"t":"broken","es":["a","b","s":[]}' } }] }),
    text: async () => ""
  });
}

test("screenshot regression: financial-PDF-shaped fallback produces a meaningful, source-grounded spec, not generic 'Bagian N'", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = forceInvalidJsonFetch();

  try {
    const result = await planDocument({
      brief: SCREENSHOT_LIKE_FIXTURE,
      documentType: "Laporan profesional",
      sectionCount: 12
    });

    assert.equal(result.source, "fallback");
    assert.equal(result.errorCode, "invalid_json", "must actually be exercising the deterministic fallback path, not a lucky parse");

    const spec = result.spec;

    // Title: the bilingual cover page must resolve to the company name, not
    // a generic label and not left as five unrelated paragraphs. Verbatim
    // casing from the source ("PT MERDEKA COPPER GOLD Tbk", matching the
    // real report's cover-page typography) — reformatting casing would be
    // inventing text not literally present in the source.
    assert.equal(spec.title, "PT MERDEKA COPPER GOLD Tbk");

    // No generic "Bagian N" heading anywhere.
    for (const section of spec.sections) {
      assert.doesNotMatch(section.heading, /^Bagian \d+$/,
        `section heading must be meaningful, got "${section.heading}"`);
    }

    // Executive summary must list real section names, not "Bagian 1".
    for (const item of spec.executiveSummary) {
      assert.doesNotMatch(item, /^Bagian \d+$/);
    }
    assert.ok(spec.executiveSummary.length >= 1);

    // The financial statement headings must appear as real section headings,
    // with the bilingual mirror reduced (not duplicated visibly).
    const headings = spec.sections.map((s) => s.heading);
    assert.ok(headings.some((h) => /laporan posisi keuangan/i.test(h)), "statement of financial position heading must be preserved");
    assert.ok(headings.some((h) => /laporan laba rugi/i.test(h)), "profit or loss heading must be preserved");
    for (const h of headings) {
      assert.doesNotMatch(h, /profit or loss|financial position/i,
        `heading "${h}" must not visibly duplicate the English mirror alongside the Indonesian one`);
    }

    // Financial rows must survive with their figures, associated with their
    // own row label — not lost, not turned into unrelated prose.
    const allBullets = spec.sections.flatMap((s) => s.bullets);
    assert.ok(allBullets.some((b) => /kas dan setara kas/i.test(b) && /91,003/.test(b)),
      "a statement row's label and figures must stay associated");
    assert.ok(allBullets.some((b) => /pendapatan bersih/i.test(b) && /512,300/.test(b)),
      "a second statement section's row must also survive");

    // Repeated header/footer-style line ("PT Merdeka Copper Gold Tbk -
    // Laporan Keuangan Interim", repeated on every synthetic page) must not
    // become its own body paragraph/bullet content on every section.
    const repeatedLineCount = spec.sections.filter((s) =>
      s.paragraphs.some((p) => /^PT Merdeka Copper Gold Tbk - Laporan Keuangan Interim$/.test(p))
      || s.bullets.some((b) => /^PT Merdeka Copper Gold Tbk - Laporan Keuangan Interim$/.test(b))
    ).length;
    assert.ok(repeatedLineCount <= 1, "a repeated running header/footer line must not appear as body content in most sections");

    // Page markers must never become paragraph/bullet text.
    for (const section of spec.sections) {
      for (const p of [...section.paragraphs, ...section.bullets]) {
        assert.doesNotMatch(p, /^\[Page \d+\]/, "a page marker must never become body text");
      }
    }

    // Must still build a valid DOCX.
    const base64 = buildDocumentDocxBase64(spec);
    const bytes = Buffer.from(base64, "base64");
    assert.equal(bytes.subarray(0, 2).toString("ascii"), "PK");
    assert.ok(bytes.length > 1000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("screenshot regression: requesting 12 sections on a source with fewer meaningful sections returns only the meaningful ones, not 12 fabricated ones", async () => {
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.window ??= { setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = forceInvalidJsonFetch();

  try {
    const result = await planDocument({
      brief: SCREENSHOT_LIKE_FIXTURE,
      documentType: "Laporan profesional",
      sectionCount: 12
    });
    // Fixture has 2 real financial-statement sections plus, at most, a small
    // leading "Ikhtisar" bucket for the cover-page lines before the first
    // detected heading — nowhere near 12. Must not be padded to 12.
    assert.ok(result.spec.sections.length < 12,
      `expected fewer than the requested 12 sections, got ${result.spec.sections.length}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

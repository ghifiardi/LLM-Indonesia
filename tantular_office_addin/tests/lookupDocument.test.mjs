// Reading the real document, per host, with Office mocked.
//
// This text decides what the verifier protects and what the approval token is
// bound to. A reader that quietly returns "" would send a lookup whose answer
// could only ever be refused — after the query had already left the machine.

import test from "node:test";
import assert from "node:assert/strict";
import { readLookupDocument, MAX_DOCUMENT_CHARS } from "../src/chat/lookupDocument.js";

function clearHosts() {
  delete globalThis.Word; delete globalThis.Excel; delete globalThis.PowerPoint;
}

function mockWord(text) {
  globalThis.Word = { run: async (fn) => fn({
    document: { body: { text, load() {} } }, sync: async () => {} }) };
}

function mockExcel({ values, address = "Sheet1!A1:B2" }) {
  globalThis.Excel = { run: async (fn) => fn({
    workbook: { getSelectedRange: () => ({
      address, values,
      rowCount: values.length, columnCount: values[0]?.length || 0,
      load() {} }) },
    sync: async () => {} }) };
}

function mockPowerPoint(slides, { supported = true, requireLoad = false } = {}) {
  globalThis.PowerPoint = { run: async (fn) => {
    const pending = new Set();
    const loaded = new Set();
    const ranges = slides.map((lines) => lines.map((text) => {
      const range = {
        load(prop) {
          if (prop === "text") pending.add(range);
        },
        get text() {
          if (requireLoad && !loaded.has(range)) {
            throw new Error("PropertyNotLoaded: text");
          }
          return text;
        }
      };
      return range;
    }));
    return fn({
      presentation: supported ? { getSelectedSlides: () => ({
        items: ranges.map((slideRanges) => ({
          load() {},
          shapes: { items: slideRanges.map((textRange) => ({ textFrame: { textRange } })),
                    load() {} }
        })),
        load() {} }) } : {},
      sync: async () => {
        for (const range of pending) loaded.add(range);
        pending.clear();
      }
    });
  } };
}

test.afterEach(clearHosts);

test("Word: the body text is read", async () => {
  mockWord("LAPORAN\nVendor utama PT Sinar Mas. Pagu Rp 1.750.000.000.");
  const out = await readLookupDocument("Word");
  assert.equal(out.ok, true);
  assert.ok(out.text.includes("PT Sinar Mas"));
  assert.equal(out.truncated, false);
});

test("Word: an empty document is refused, not sent", async () => {
  mockWord("   \n  ");
  const out = await readLookupDocument("Word");
  assert.equal(out.ok, false);
  assert.equal(out.reason, "empty_document");
});

test("Excel: the SELECTED range is read, with its address", async () => {
  // Not the whole workbook. If this text ever reached anything but the
  // companion, sending every sheet would be egress by accident.
  mockExcel({ values: [["Vendor", "PT Sinar Mas"], ["Pagu", "1750000000"]] });
  const out = await readLookupDocument("Excel");
  assert.equal(out.ok, true);
  assert.ok(out.text.includes("Sheet1!A1:B2"));
  assert.ok(out.text.includes("PT Sinar Mas"));
});

test("Excel: an empty selection is refused", async () => {
  mockExcel({ values: [["", ""], ["", ""]] });
  const out = await readLookupDocument("Excel");
  assert.equal(out.ok, false);
  assert.equal(out.reason, "empty_selection");
});

test("PowerPoint: the selected slides' text is read", async () => {
  mockPowerPoint([["Anggaran 2026", "Vendor PT Sinar Mas"], ["Realisasi 23,6 persen"]]);
  const out = await readLookupDocument("PowerPoint");
  assert.equal(out.ok, true);
  assert.ok(out.text.includes("PT Sinar Mas"));
  assert.ok(out.text.includes("Slide 2"));
});

test("PowerPoint: text is loaded and synced before it is read", async () => {
  // This matches the Office proxy contract more closely than an eager property
  // mock. The old reader failed here with PropertyNotLoaded even while its
  // hand-written happy-path mock passed.
  mockPowerPoint([["Vendor PT Sinar Mas"]], { requireLoad: true });
  const out = await readLookupDocument("PowerPoint");
  assert.equal(out.ok, true);
  assert.ok(out.text.includes("PT Sinar Mas"));
});

test("PowerPoint: no selection is refused", async () => {
  mockPowerPoint([]);
  assert.equal((await readLookupDocument("PowerPoint")).reason, "empty_selection");
});

test("PowerPoint: slides with no text are refused, not sent as slide headings", async () => {
  mockPowerPoint([[], []]);
  assert.equal((await readLookupDocument("PowerPoint")).reason, "empty_selection");
});

test("PowerPoint: a host without getSelectedSlides is reported, not guessed at", async () => {
  mockPowerPoint([], { supported: false });
  assert.equal((await readLookupDocument("PowerPoint")).reason, "host_unavailable");
});

test("a missing Office API is reported rather than read as empty", async () => {
  clearHosts();
  for (const host of ["Word", "Excel", "PowerPoint"]) {
    assert.equal((await readLookupDocument(host)).reason, "host_unavailable", host);
  }
});

test("an Office API that throws does not become an empty document", async () => {
  globalThis.Word = { run: async () => { throw new Error("Word is busy"); } };
  const out = await readLookupDocument("Word");
  assert.equal(out.ok, false);
  assert.equal(out.reason, "read_failed");
  assert.ok(out.message.includes("Word is busy"));
});

test("an unsupported host is refused", async () => {
  assert.equal((await readLookupDocument("Outlook")).reason, "unsupported_host");
  assert.equal((await readLookupDocument("")).reason, "unsupported_host");
});

test("truncation is reported, never silent", async () => {
  // A user must not be told the answer was checked against "the document" when
  // it was checked against the first half of it.
  mockWord("A".repeat(MAX_DOCUMENT_CHARS + 500));
  const out = await readLookupDocument("Word");
  assert.equal(out.truncated, true);
  assert.equal(out.text.length, MAX_DOCUMENT_CHARS);
});

// --- host re-detection ---------------------------------------------------
// Office.onReady delivered an empty host on a real-Excel pane reload
// (2026-08-25); every lookup then failed unsupported_host from the stale
// snapshot. At click time Office.context is populated, so re-detect.

import { resolveLookupHost } from "../src/chat/lookupDocument.js";

test("a known cached host is trusted without re-detection", () => {
  assert.equal(resolveLookupHost("Excel", () => { throw new Error("must not run"); }),
               "Excel");
});

test("a stale 'Office' snapshot is re-detected at call time", () => {
  assert.equal(resolveLookupHost("Office", () => "Excel"), "Excel");
});

test("a re-detection that also fails keeps the refusal, not a guess", () => {
  // Guessing a host would read the wrong document API and could return the
  // wrong text; unsupported_host is the honest outcome.
  assert.equal(resolveLookupHost("Office", () => "Office"), "Office");
  assert.equal(resolveLookupHost("Office", undefined), "Office");
});

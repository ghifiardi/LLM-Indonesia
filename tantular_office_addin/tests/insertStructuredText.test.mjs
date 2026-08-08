import test from "node:test";
import assert from "node:assert/strict";
import {
  insertStructuredTextAfterSelection,
  insertStructuredTextIntoWord
} from "../src/officeClient.js";

const SAMPLE = [
  "### Judul Bagian",
  "Paragraf pembuka.",
  "- Butir pertama",
  "- Butir kedua",
  "1. Langkah satu",
  "2. Langkah dua"
].join("\n");

function installWordMock({ supportsWordApi13, searchHit = false, failStyleSync = false, htmlSupported = false }) {
  const paragraphs = [];
  const htmlInserts = [];
  const makeParagraph = (text) => {
    const paragraph = {
      text,
      font: {},
      styleBuiltIn: undefined,
      insertParagraph(nextText, location) {
        assert.equal(location, "After");
        const next = makeParagraph(nextText);
        paragraphs.push(next);
        return next;
      }
    };
    if (htmlSupported) {
      paragraph.insertHtml = (html, location) => {
        // Some hosts reject Before/After on Paragraph.insertHtml.
        if (htmlSupported === "end-only" && location !== "End") {
          const error = new Error("InvalidArgument");
          error.code = "InvalidArgument";
          throw error;
        }
        htmlInserts.push({ html, location });
      };
    }
    return paragraph;
  };
  const body = {
    insertParagraph(text, location) {
      assert.equal(location, "End");
      const paragraph = makeParagraph(text);
      paragraphs.push(paragraph);
      return paragraph;
    },
    search() {
      if (!searchHit) return { load() {}, items: [] };
      // Two occurrences: the original sub-section and a later duplicate (e.g.
      // an answer previously appended at the end of the document).
      const original = makeParagraph("anchor-original");
      const duplicate = makeParagraph("anchor-duplicate");
      duplicate.insertParagraph = () => {
        throw new Error("anchored to the duplicate occurrence instead of the original");
      };
      return { load() {}, items: [original, duplicate] };
    }
  };
  const selectedParagraph = makeParagraph("paragraf terpilih");
  let syncCount = 0;
  globalThis.Word = {
    run: async (callback) => callback({
      document: {
        body,
        getSelection: () => ({ paragraphs: { load() {}, items: [selectedParagraph] } })
      },
      sync: async () => {
        syncCount += 1;
        // The style batch is the sync after the text has been committed.
        if (failStyleSync && syncCount >= 2) {
          const error = new Error("InvalidArgument");
          error.code = "InvalidArgument";
          throw error;
        }
      }
    }),
    InsertLocation: { after: "After", end: "End" },
    BuiltInStyleName: {
      heading1: "Heading1",
      heading2: "Heading2",
      heading3: "Heading3",
      listBullet: "ListBullet",
      listNumber: "ListNumber"
    }
  };
  globalThis.Office = {
    context: {
      requirements: {
        isSetSupported: (set, version) =>
          set === "WordApi" && supportsWordApi13 && Number(version) <= 1.3
      }
    }
  };
  if (htmlSupported) {
    body.insertHtml = (html, location) => {
      htmlInserts.push({ html, location });
    };
  }
  paragraphs.htmlInserts = htmlInserts;
  return paragraphs;
}

function removeWordMock() {
  delete globalThis.Word;
  delete globalThis.Office;
}

test("uses built-in styles when the host supports WordApi 1.3", async (t) => {
  t.after(removeWordMock);
  const paragraphs = installWordMock({ supportsWordApi13: true });
  await insertStructuredTextIntoWord(SAMPLE);
  assert.deepEqual(
    paragraphs.map((p) => [p.text, p.styleBuiltIn]),
    [
      ["Judul Bagian", "Heading3"],
      ["Paragraf pembuka.", undefined],
      ["Butir pertama", "ListBullet"],
      ["Butir kedua", "ListBullet"],
      ["Langkah satu", "ListNumber"],
      ["Langkah dua", "ListNumber"]
    ]
  );
});

test("falls back to WordApi 1.1 formatting when styleBuiltIn is unsupported", async (t) => {
  t.after(removeWordMock);
  const paragraphs = installWordMock({ supportsWordApi13: false });
  await insertStructuredTextIntoWord(SAMPLE);
  // styleBuiltIn raises InvalidArgument on hosts without WordApi 1.3, so it
  // must never be assigned there; lists keep their markers as plain text.
  assert.deepEqual(
    paragraphs.map((p) => [p.text, p.styleBuiltIn, p.font.bold === true]),
    [
      ["Judul Bagian", undefined, true],
      ["Paragraf pembuka.", undefined, false],
      ["• Butir pertama", undefined, false],
      ["• Butir kedua", undefined, false],
      ["1. Langkah satu", undefined, false],
      ["2. Langkah dua", undefined, false]
    ]
  );
});

test("keeps inserted text when the host rejects the styling batch", async (t) => {
  t.after(removeWordMock);
  const paragraphs = installWordMock({ supportsWordApi13: true, failStyleSync: true });
  const message = await insertStructuredTextIntoWord(SAMPLE);
  assert.equal(paragraphs.length, 6);
  assert.match(message, /dimasukkan/);
  assert.match(message, /tanpa gaya/);
});

test("prefers insertHtml so tables and headings keep their formatting", async (t) => {
  t.after(removeWordMock);
  const paragraphs = installWordMock({ supportsWordApi13: false, htmlSupported: true });
  const withTable = `${SAMPLE}\n| A | B |\n| --- | --- |\n| 1 | 2 |`;
  const message = await insertStructuredTextAfterSelection(withTable);
  assert.equal(paragraphs.length, 0, "HTML path must not fall back to paragraphs");
  assert.equal(paragraphs.htmlInserts.length, 1);
  assert.equal(paragraphs.htmlInserts[0].location, "After");
  assert.match(paragraphs.htmlInserts[0].html, /<table[^>]*>/);
  assert.match(paragraphs.htmlInserts[0].html, /<h3>Judul Bagian<\/h3>/);
  assert.match(message, /setelah paragraf yang dipilih/);
});

test("retries insertHtml at End when the host rejects After", async (t) => {
  t.after(removeWordMock);
  const paragraphs = installWordMock({ supportsWordApi13: false, htmlSupported: "end-only" });
  const message = await insertStructuredTextAfterSelection(SAMPLE);
  assert.equal(paragraphs.length, 0, "must stay on the HTML path");
  assert.equal(paragraphs.htmlInserts.length, 1);
  assert.equal(paragraphs.htmlInserts[0].location, "End");
  assert.match(message, /setelah paragraf yang dipilih/);
});

test("inserts right after the user's selected paragraph", async (t) => {
  t.after(removeWordMock);
  const paragraphs = installWordMock({ supportsWordApi13: false });
  const message = await insertStructuredTextAfterSelection(SAMPLE);
  assert.equal(paragraphs.length, 6);
  assert.match(message, /setelah paragraf yang dipilih/);
});

test("targeted insert still anchors after the searched range on old hosts", async (t) => {
  t.after(removeWordMock);
  const paragraphs = installWordMock({ supportsWordApi13: false, searchHit: true });
  const message = await insertStructuredTextIntoWord(SAMPLE, {
    afterText: "portofolio open-weight",
    fallbackToEnd: false
  });
  assert.match(message, /setelah sub-section terkait/);
  assert.equal(paragraphs.length, 6);
});

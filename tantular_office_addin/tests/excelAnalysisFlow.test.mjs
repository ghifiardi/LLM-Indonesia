// Drives the real mountExcelChatPane() end to end for local analytics, with a
// minimal fake DOM and a fake Excel.run workbook (synthetic data). Network
// APIs are trapped: an analytics turn must make no request at all — no model
// call, no companion call. Writes must wait for "Terapkan" and are refused when
// the analysed cells changed. This is not real Excel: it proves the chat's
// routing, gating and stale checks, not Office.js behaviour.
import test from "node:test";
import assert from "node:assert/strict";

// --- Minimal DOM ---------------------------------------------------------------

class El {
  constructor(tag, id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.parent = null;
    this.className = "";
    this.ownText = "";
    this.style = {};
    this.listeners = {};
    this.disabled = false;
    this.value = "";
    this.type = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
    const classes = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      add: (...c) => { this.className = [...new Set([...classes(), ...c])].join(" "); },
      remove: (...c) => { this.className = classes().filter((x) => !c.includes(x)).join(" "); },
      contains: (c) => classes().includes(c),
      toggle: (c, on) => (on ?? !classes().includes(c) ? this.classList.add(c) : this.classList.remove(c))
    };
  }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join("\n"); }
  set textContent(v) { this.ownText = String(v); this.children = []; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  append(...children) { children.forEach((c) => this.appendChild(c)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  focus() {}
  click() { if (!this.disabled) for (const fn of this.listeners.click || []) fn({ preventDefault() {} }); }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) {
    if (sel.startsWith("#")) return [...this.walk()].filter((e) => e.id === sel.slice(1));
    const [cls, tag] = sel.slice(1).split(" ");
    const hosts = [...this.walk()].filter((e) => e.classList.contains(cls));
    return tag ? hosts.flatMap((h) => [...h.walk()].filter((e) => e.tagName === tag.toUpperCase())) : hosts;
  }
}

function mountDom() {
  const card = new El("section", "chat-card");
  card.className = "hidden";
  for (const [tag, id] of [["div", "chat-messages"], ["textarea", "chat-input"], ["button", "chat-send"], ["button", "chat-stop"], ["span", "chat-context-pill"], ["div", "chat-chips"]]) {
    card.appendChild(new El(tag, id));
  }
  globalThis.document = {
    querySelector: (sel) => (sel === "#chat-card" ? card : card.querySelector(sel)),
    createElement: (tag) => new El(tag)
  };
  return card;
}

// --- Fake workbook ---------------------------------------------------------------

const colNumber = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n) => { let s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
function parse(address) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(address.replace(/\$/g, ""));
  return { r1: +m[2] - 1, c1: colNumber(m[1]) - 1, r2: +(m[4] ?? m[2]) - 1, c2: colNumber(m[3] ?? m[1]) - 1 };
}
const addr = (r1, c1, r2, c2) => `${colName(c1 + 1)}${r1 + 1}:${colName(c2 + 1)}${r2 + 1}`;

function fakeExcel(sheets, { active, selection = "A1" }) {
  const log = { writes: [], added: [] };
  const range = (name, address) => {
    const { r1, c1, r2, c2 } = parse(address);
    const sheet = sheets[name];
    const block = (grid, blank) => Array.from({ length: r2 - r1 + 1 }, (_, r) => Array.from({ length: c2 - c1 + 1 }, (_, c) => grid[r1 + r]?.[c1 + c] ?? blank));
    return {
      address: `${name}!${address}`, rowCount: r2 - r1 + 1, columnCount: c2 - c1 + 1, rowIndex: r1, columnIndex: c1,
      isNullObject: false,
      worksheet: { name, load() {} },
      format: { autofitColumns() {}, font: {} },
      load() {},
      get values() { return block(sheet.values, ""); },
      set values(v) {
        v.forEach((row, r) => row.forEach((x, c) => { (sheet.values[r1 + r] ||= [])[c1 + c] = x; }));
        log.writes.push({ sheet: name, address, values: v });
      },
      get numberFormat() { return block(sheet.formats, "General"); },
      get formulas() { return block(sheet.values, ""); }
    };
  };
  const sheetApi = (name) => ({
    name, isNullObject: false, load() {}, activate() {},
    getRange: (address) => range(name, address),
    getRangeByIndexes: (r, c, rows, cols) => range(name, addr(r, c, r + rows - 1, c + cols - 1)),
    getUsedRangeOrNullObject() {
      const v = sheets[name].values;
      if (!v.length) return { isNullObject: true, load() {} };
      return range(name, addr(0, 0, v.length - 1, Math.max(...v.map((r) => r.length)) - 1));
    }
  });
  const worksheets = {
    load() {},
    get items() { return Object.keys(sheets).map((name) => ({ name })); },
    getActiveWorksheet: () => sheetApi(active),
    getItem: (name) => sheetApi(name),
    getItemOrNullObject: (name) => (sheets[name] ? sheetApi(name) : { isNullObject: true, load() {} }),
    add(name) { sheets[name] = { values: [], formats: [] }; log.added.push(name); return sheetApi(name); }
  };
  const workbook = { worksheets, getSelectedRange: () => range(active, selection) };
  globalThis.Excel = { run: async (fn) => fn({ workbook, sync: async () => {} }) };
  return log;
}

// Synthetic sales data: dates as Excel serials with a date format.
function salesSheet() {
  const regions = ["Jakarta", "Bandung", "Surabaya"];
  const values = [["Tanggal", "Region", "Pendapatan", "Pesanan"]];
  for (let i = 0; i < 36; i += 1) values.push([46023 + i * 10, regions[i % 3], 100 + i * 4 + (i % 3) * 20, 10 + i]);
  const formats = values.map((row, r) => row.map((_, c) => (c === 0 && r > 0 ? "yyyy-mm-dd" : "General")));
  return { values, formats };
}

// --- Harness ---------------------------------------------------------------------

const network = [];
globalThis.fetch = async (...args) => { network.push(["fetch", String(args[0])]); throw new Error("network blocked in test"); };
globalThis.XMLHttpRequest = class { open(...a) { network.push(["xhr", String(a[1])]); } send() { throw new Error("blocked"); } };
globalThis.WebSocket = class { constructor(u) { network.push(["ws", String(u)]); throw new Error("blocked"); } };
const quiet = { warn: console.warn, error: console.error };
console.warn = () => {};
console.error = () => {};
test.after(() => Object.assign(console, quiet));

const settle = async () => { for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r)); };
const { mountExcelChatPane } = await import("../src/chat/excelChat.js");

async function setup() {
  const book = { Data: salesSheet() };
  const log = fakeExcel(book, { active: "Data" });
  const card = mountDom();
  mountExcelChatPane();
  await settle();
  network.length = 0;
  const messages = card.querySelector("#chat-messages");
  const say = async (text) => { card.querySelector("#chat-input").value = text; card.querySelector("#chat-send").click(); await settle(); };
  const last = () => messages.children[messages.children.length - 1];
  const button = (label) => [...messages.walk()].reverse().find((e) => e.tagName === "BUTTON" && e.textContent === label);
  return { book, log, card, say, last, button };
}

test("descriptive statistics run locally: no network request, workbook untouched", async () => {
  const { log, say, last } = await setup();
  await say("statistik deskriptif");
  const text = last().textContent;
  assert.match(text, /Statistik deskriptif \(2 kolom, 36 baris data\)/);
  assert.match(text, /Sumber: Data!A1:D37 \(sheet aktif\)/);
  assert.match(text, /Pendapatan — n 36/);
  assert.match(text, /tidak ada data yang dikirim/);
  assert.deepEqual(network, [], "an analytics turn makes no request of any kind");
  assert.deepEqual(log.writes, []);
  assert.deepEqual(log.added, []);
});

test("unclear columns: the chat asks, a chip answers, the result follows — still offline", async () => {
  const { say, last, button } = await setup();
  await say("korelasi Pendapatan");
  assert.match(last().textContent, /Korelasikan "Pendapatan" dengan kolom mana\?/);
  button("Pesanan").click();
  await settle();
  assert.match(last().textContent, /Pendapatan ↔ Pesanan: r = 0,9\d+ \(sangat kuat, positif\)/);
  assert.deepEqual(network, []);
});

test("cancelling an open analytics question changes nothing", async () => {
  const { log, say, last, button } = await setup();
  await say("analisis data ini");
  assert.match(last().textContent, /Analisis apa yang Anda inginkan/);
  button("Batal").click();
  await settle();
  assert.equal(last().textContent, "Dibatalkan — workbook tidak diubah.");
  assert.deepEqual(log.writes, []);
  assert.deepEqual(network, []);
});

test("group comparison and time series run end to end", async () => {
  const { say, last } = await setup();
  await say("bandingkan Pendapatan per Region");
  assert.match(last().textContent, /ANOVA: F = /);
  await say("tren Pendapatan bulanan");
  assert.match(last().textContent, /Tren "Pendapatan" \(jumlah per bulan\)/);
  assert.match(last().textContent, /Tren linear: naik/);
  assert.deepEqual(network, []);
});

test("saving results: preview first, a new sheet only after Terapkan", async () => {
  const { book, log, say, last, button } = await setup();
  await say("bandingkan Pendapatan per Region");
  const answer = last();
  button("Simpan hasil ke sheet baru").click();
  await settle();
  assert.match(answer.textContent, /Pratinjau 1 perubahan:/);
  assert.match(answer.textContent, /Sheet baru "Analisis Perbandingan"/);
  assert.deepEqual(log.added, [], "the review card alone writes nothing");
  button("Terapkan").click();
  await settle();
  assert.deepEqual(log.added, ["Analisis Perbandingan"]);
  assert.deepEqual(book["Analisis Perbandingan"].values[0], ["Kelompok", "n", "Rata-rata", "Median", "Simpangan baku", "Min", "Maks"]);
  assert.equal(book["Analisis Perbandingan"].values[1][0], "Bandung");
  assert.match(answer.textContent, /✅ Sheet "Analisis Perbandingan" dibuat/);
  assert.deepEqual(network, []);
});

test("stale data: an edit after the analysis blocks the save, before and at Terapkan", async () => {
  const early = await setup();
  await early.say("statistik deskriptif");
  early.book.Data.values[5][2] = 9999;
  early.button("Simpan hasil ke sheet baru").click();
  await settle();
  assert.match(early.last().textContent, /Data sumber berubah sejak analisis dihitung/);
  assert.equal(early.button("Terapkan"), undefined, "no review card for stale results");

  const late = await setup();
  await late.say("statistik deskriptif");
  late.button("Simpan hasil ke sheet baru").click();
  await settle();
  late.book.Data.values[7][3] = -1;
  late.button("Terapkan").click();
  await settle();
  assert.match(late.last().textContent, /❌ Data sumber berubah sejak analisis dihitung/);
  assert.deepEqual(late.log.added, []);
});

test("chart requests still go to the existing planner, not to local analytics", async () => {
  const { say, last } = await setup();
  await say("Buat chart dari data di sheet ini");
  assert.doesNotMatch(last().textContent, /analisis lokal|Statistik deskriptif/i);
  assert.ok(network.length > 0 || last().classList.contains("error"), "the planner path was taken");
});

test("source invariants: analytics modules cannot reach a model or the network", async () => {
  const fs = await import("node:fs");
  const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  for (const rel of ["src/chat/analysisTable.js", "src/chat/analysisIntent.js", "src/chat/analysisReport.js"]) {
    const source = read(rel);
    const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);
    assert.deepEqual(imports.filter((spec) => !/^\.\/(excelClarify|excelSeriesChart|analysisTable)\.js$|^\.\.\/vendor\/tantular-dashboard\/stats\.mjs$/.test(spec)), [], `${rel} imports only pure helpers`);
    assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/, `${rel} makes no request`);
  }
  // In send(), the analytics route comes before the planner reads the workbook or calls the model.
  const chat = read("src/chat/excelChat.js");
  const sendBody = chat.slice(chat.indexOf("async function send("));
  const route = sendBody.indexOf("isAnalysisRequest(message)");
  assert.ok(route > 0 && route < sendBody.indexOf("getExcelChatContext()") && route < sendBody.indexOf("runTantular("));
});

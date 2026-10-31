// A batching fake of Excel.run for chart tests. Like Office.js, calls that
// change the workbook are QUEUED and run at context.sync(); a failing call
// rejects that sync with debugInfo.errorLocation, the calls queued before it
// have already taken effect (so a chart can exist although the sync failed),
// and the calls after it are dropped. `failOn(call, args)` injects Excel's
// error at a named call. Reads (values, formats, rowHidden) are immediate.

const MAX_COLS = 16384;
const MAX_ROWS = 1048576;
const colNumber = (letters) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n) => { let s = ""; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const addr = (r1, c1, r2, c2) => (r1 === r2 && c1 === c2 ? `${colName(c1 + 1)}${r1 + 1}` : `${colName(c1 + 1)}${r1 + 1}:${colName(c2 + 1)}${r2 + 1}`);
function parse(address) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(String(address).replace(/\$/g, "").split("!").pop());
  if (!m) throw new Error(`fake: bad address ${address}`);
  return { r1: +m[2] - 1, c1: colNumber(m[1]) - 1, r2: +(m[4] ?? m[2]) - 1, c2: colNumber(m[3] ?? m[1]) - 1 };
}

export function excelError(message, code = "InvalidArgument") {
  return Object.assign(new Error(message), { name: "RichApi.Error", code });
}

// sheets: { name: { values, formats?, text?, hiddenRows?: Set<1-based row>, usedRange? } }
export function installFakeExcel(sheets, { active, selection = "A1", failOn = () => null, unsupportedTypes = [] } = {}) {
  const log = { calls: [], syncs: 0 };
  let chartCounter = 6;
  const charts = (name) => (sheets[name].charts ||= []);

  function makeContext() {
    const queue = [];
    const enqueue = (call, args, run) => queue.push({ call, args, run });
    const context = {
      async sync() {
        log.syncs += 1;
        const ops = queue.splice(0);
        for (const op of ops) {
          log.calls.push(`${op.call}(${op.args.join(", ")})`);
          const injected = failOn(op.call, op.args);
          try {
            if (injected) throw injected;
            op.run();
          } catch (error) {
            error.debugInfo = { errorLocation: op.call, code: error.code };
            throw error;
          }
        }
      }
    };

    const range = (sheetName, address) => {
      const { r1, c1, r2, c2 } = parse(address);
      const sheet = sheets[sheetName];
      const block = (grid, blank) => Array.from({ length: r2 - r1 + 1 }, (_, r) => Array.from({ length: c2 - c1 + 1 }, (_, c) => grid?.[r1 + r]?.[c1 + c] ?? blank));
      const self = {
        kind: "range", sheetName, r1, c1, r2, c2,
        address: `${sheetName}!${addr(r1, c1, r2, c2)}`,
        rowCount: r2 - r1 + 1, columnCount: c2 - c1 + 1, rowIndex: r1, columnIndex: c1,
        worksheet: { name: sheetName, load() {} },
        load() {},
        get values() { return block(sheet.values, ""); },
        set values(v) {
          enqueue("Range.values", [self.address], () => v.forEach((row, r) => row.forEach((x, c) => { (sheet.values[r1 + r] ||= [])[c1 + c] = x; })));
        },
        get numberFormat() { return block(sheet.formats, "General"); },
        get text() { return block(sheet.text, ""); },
        get rowHidden() { return [...Array(r2 - r1 + 1).keys()].every((i) => sheet.hiddenRows?.has(r1 + i + 1)); },
        getRow(i) { return range(sheetName, addr(r1 + i, c1, r1 + i, c2)); },
        getCell(r, c) { return range(sheetName, addr(r1 + r, c1 + c, r1 + r, c1 + c)); },
        getOffsetRange(dr, dc) {
          const out = { r1: r1 + dr, c1: c1 + dc, r2: r2 + dr, c2: c2 + dc };
          const target = out.r1 >= 0 && out.c1 >= 0 && out.r2 < MAX_ROWS && out.c2 < MAX_COLS ? range(sheetName, addr(out.r1, out.c1, out.r2, out.c2)) : { ...self, address: "(out of range)", invalid: true };
          enqueue("Range.getOffsetRange", [`${dr}, ${dc}`], () => { if (target.invalid) throw excelError("Parameter out of range"); });
          return target;
        },
        select() { enqueue("Range.select", [self.address], () => {}); },
        format: { autofitColumns() { enqueue("RangeFormat.autofitColumns", [], () => {}); }, font: {} }
      };
      return self;
    };

    const chartProxy = (sheetName, state) => {
      const seriesProxy = (index) => {
        const proxy = {
          set name(v) { enqueue("ChartSeries.name", [JSON.stringify(v)], () => { state.series[index].name = v; }); },
          setXAxisValues(r) { enqueue("ChartSeries.setXAxisValues", [r.address], () => { state.series[index].x = r.address; }); },
          setValues(r) { enqueue("ChartSeries.setValues", [r.address], () => { state.series[index].values = r.address; }); }
        };
        return proxy;
      };
      return {
        get name() { return state.created ? state.name : undefined; },
        load() {},
        series: {
          getItemAt(i) {
            enqueue("ChartSeriesCollection.getItemAt", [String(i)], () => { if (!state.series[i]) throw excelError("The requested resource doesn't exist.", "ItemNotFound"); });
            return seriesProxy(i);
          },
          add(name) {
            const index = state.pendingSeries++;
            enqueue("ChartSeriesCollection.add", [JSON.stringify(name)], () => { state.series[index] = { name }; });
            return seriesProxy(index);
          }
        },
        title: { set text(v) { enqueue("ChartTitle.text", [JSON.stringify(v)], () => { state.title = v; }); } },
        legend: { set position(v) { enqueue("ChartLegend.position", [JSON.stringify(v)], () => { state.legend = v; }); } },
        axes: { categoryAxis: {}, valueAxis: {} },
        setPosition(a, b) { enqueue("Chart.setPosition", [a.address, b.address], () => { if (a.invalid || b.invalid) throw excelError("Parameter out of range"); state.position = [a.address, b.address]; }); },
        delete() { enqueue("Chart.delete", [JSON.stringify(state.name)], () => { state.deleted = true; }); }
      };
    };

    const sheetApi = (name) => ({
      name, isNullObject: false, load() {},
      delete() { enqueue("Worksheet.delete", [JSON.stringify(name)], () => { delete sheets[name]; }); },
      getRange: (address) => range(name, address),
      getRangeByIndexes(r, c, rows, cols) {
        const ok = r >= 0 && c >= 0 && r + rows <= MAX_ROWS && c + cols <= MAX_COLS;
        const target = ok ? range(name, addr(r, c, r + rows - 1, c + cols - 1)) : { address: "(out of range)", invalid: true, load() {}, getOffsetRange() { return this; }, select() {} };
        enqueue("Worksheet.getRangeByIndexes", [r, c, rows, cols].map(String), () => { if (!ok) throw excelError("Parameter out of range"); });
        return target;
      },
      getUsedRange(valuesOnly = false) {
        const sheet = sheets[name];
        const used = !valuesOnly && sheet.usedRange ? sheet.usedRange : addr(0, 0, sheet.values.length - 1, Math.max(...sheet.values.map((r) => r.length)) - 1);
        return range(name, used);
      },
      charts: {
        add(type, source, seriesBy) {
          const state = { name: `Chart ${++chartCounter}`, type, source: source.address, seriesBy, series: [], pendingSeries: 1, created: false };
          enqueue("ChartCollection.add", [JSON.stringify(type), source.address, JSON.stringify(seriesBy)], () => {
            if (unsupportedTypes.includes(type)) throw excelError("The argument is invalid or missing or has an incorrect format.");
            state.created = true;
            state.series[0] = { name: "", values: source.address };
            charts(name).push(state);
          });
          return chartProxy(name, state);
        },
        load() {},
        get items() { return charts(name).filter((c) => !c.deleted).map((c) => ({ name: c.name })); },
        getItemOrNullObject(chartName) {
          const state = charts(name).find((c) => c.name === chartName && !c.deleted);
          return state ? { ...chartProxy(name, state), isNullObject: false } : { isNullObject: true, load() {}, delete() {} };
        }
      }
    });

    const worksheets = {
      load() {},
      get items() { return Object.keys(sheets).map((n) => ({ name: n })); },
      getActiveWorksheet: () => sheetApi(active),
      getItem: (n) => sheetApi(n),
      getItemOrNullObject: (n) => (sheets[n] ? sheetApi(n) : { isNullObject: true, load() {} }),
      add(n) {
        enqueue("WorksheetCollection.add", [JSON.stringify(n)], () => { sheets[n] = { values: [], formats: [] }; });
        return sheetApi(n);
      }
    };
    // Sheets added in this batch exist for later proxies in the same batch.
    const workbook = { worksheets, getSelectedRange: () => range(active, selection) };
    context.workbook = workbook;
    return context;
  }

  globalThis.Excel = { run: async (fn) => fn(makeContext()) };
  globalThis.Office = { context: { requirements: { isSetSupported: () => true } } };
  const liveCharts = (name = active) => (sheets[name]?.charts || []).filter((c) => !c.deleted);
  return { log, liveCharts, sheets };
}

// The user's sheet: "Plot Data". Row 1 title, row 2 headers, row 3 HIDDEN with
// A3 = "Initial" (and starting values), weekly dates from row 4 to 62, and
// D1–D5 in N–R as numbers displayed with comma decimals ("1,25").
export function plotDataSheet() {
  const values = [];
  const formats = [];
  const text = [];
  const width = 18; // A..R
  const blank = () => Array(width).fill("");
  values[0] = blank(); values[0][0] = "Plot Data";
  values[1] = blank(); values[1][0] = "Tanggal";
  ["Bear D1", "Bear D2", "Bear D3", "Bear D4", "Bear D5"].forEach((h, i) => { values[1][13 + i] = h; });
  values[2] = blank(); values[2][0] = "Initial";
  for (let i = 0; i < 5; i += 1) values[2][13 + i] = 0;
  for (let r = 3; r < 62; r += 1) {
    values[r] = blank();
    values[r][0] = 46023 + (r - 3) * 7;
    for (let i = 0; i < 5; i += 1) values[r][13 + i] = Math.round((1 + i * 0.2 + ((r * 37 + i * 11) % 23) / 10) * 100) / 100;
  }
  for (let r = 0; r < 62; r += 1) {
    formats[r] = Array(width).fill("General");
    text[r] = values[r].map((v) => (typeof v === "number" ? String(v).replace(".", ",") : String(v)));
    if (r >= 3) {
      formats[r][0] = "dd/mm/yyyy";
      for (let i = 0; i < 5; i += 1) formats[r][13 + i] = "0.00";
      text[r][0] = new Date(Date.UTC(1899, 11, 30) + values[r][0] * 86_400_000).toISOString().slice(0, 10).split("-").reverse().join("/");
    }
  }
  return { values, formats, text, hiddenRows: new Set([3]) };
}

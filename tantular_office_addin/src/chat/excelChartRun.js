// Instrumented chart creation for the Excel chat. Office.js queues calls and
// reports a failure only at context.sync(), so one sync over seven calls
// cannot say which call threw ("Parameter out of range" after charts.add left
// an empty chart behind). Here every call is its own step: it is logged with
// its arguments, synced, and a failure names exactly that call. A chart that
// was created before the failure is deleted again, so nothing half-built
// stays on the sheet.

const LOG_PREFIX = "[TantularChart]";

// "ChartSeries.setXAxisValues('Plot Data'!A4:A62)" — args are already strings.
export const formatCall = (call, args = []) => `${call}(${args.join(", ")})`;
export const rangeArg = (sheet, address) => `'${String(sheet || "aktif").replace(/'/g, "''")}'!${address}`;

export function createStepRunner(context, { log = console.warn } = {}) {
  const trace = [];
  async function step(call, args, queue) {
    const label = formatCall(call, args);
    trace.push(label);
    const result = queue();
    try {
      await context.sync();
    } catch (error) {
      error.tantularCall = label;
      log(`${LOG_PREFIX} gagal di ${label}`, { trace: [...trace], debugInfo: error?.debugInfo, error });
      throw error;
    }
    return result;
  }
  return { step, trace };
}

// Deletes a chart created earlier in a failed run. Runs in its own Excel.run
// because the failed request context may no longer accept calls.
export async function deleteChart(sheetName, chartName) {
  if (!chartName) return false;
  return Excel.run(async (context) => {
    const sheet = sheetName ? context.workbook.worksheets.getItem(sheetName) : context.workbook.worksheets.getActiveWorksheet();
    const chart = sheet.charts.getItemOrNullObject(chartName);
    chart.load("isNullObject");
    await context.sync();
    if (chart.isNullObject) return false;
    chart.delete();
    await context.sync();
    return true;
  });
}

// Charts on the sheet now that were not there before (charts.add can create a
// chart and still fail, before its name was ever returned).
async function chartsAddedSince(sheetName, beforeNames) {
  return Excel.run(async (context) => {
    const sheet = sheetName ? context.workbook.worksheets.getItem(sheetName) : context.workbook.worksheets.getActiveWorksheet();
    sheet.charts.load("items/name");
    await context.sync();
    return sheet.charts.items.map((c) => c.name).filter((name) => !beforeNames.includes(name));
  });
}

// The error the chat shows: Excel's message, the exact call, and what
// happened to the chart that had already been created.
export async function failAfterCleanup(error, { sheet, chartName, beforeNames = null, log = console.warn }) {
  let cleanup = "";
  if (!chartName && beforeNames) {
    try {
      const added = await chartsAddedSince(sheet, beforeNames);
      if (added.length === 1) chartName = added[0];
    } catch (lookupError) {
      log(`${LOG_PREFIX} tidak bisa memeriksa chart baru`, lookupError);
    }
  }
  if (chartName) {
    try {
      cleanup = (await deleteChart(sheet, chartName))
        ? ` Chart "${chartName}" yang sempat dibuat sudah dihapus lagi.`
        : "";
    } catch (cleanupError) {
      log(`${LOG_PREFIX} gagal menghapus chart ${chartName}`, cleanupError);
      cleanup = ` ⚠️ Chart "${chartName}" yang sempat dibuat tidak bisa dihapus otomatis; hapus manual dari sheet "${sheet}".`;
    }
  }
  const where = error?.tantularCall ? ` Panggilan Office.js yang gagal: ${error.tantularCall}.` : "";
  const wrapped = new Error(`Chart gagal dibuat: ${error?.message || error}.${where}${cleanup}`);
  wrapped.cause = error;
  wrapped.tantularCall = error?.tantularCall;
  return wrapped;
}

// Statistical tools for the data studio: descriptive statistics, correlation and linear trend.
// Pure functions over the in-memory table: no network, no eval, results computed in the browser.
// Quantiles use linear interpolation (Excel PERCENTILE.INC / NumPy default); skewness is Excel SKEW.
const fail = (message) => { throw new Error(message); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toPrecision(10)));
/** "p < 0.0001" for a vanishing p-value; never "p = 0" or an exponent. */
export const pPhrase = (p) => (p < 0.0001 ? 'p < 0.0001' : `p = ${round(p)}`);

// ---------------------------------------------------------------- shared input checks

const shown = names => (names.length ? names.slice(0, 60).map(n => String(n).slice(0, 60)).join(', ') + (names.length > 60 ? `, … (${names.length} in all)` : '') : '(none)');
const numericNames = data => data.columns.filter((_, i) => data.types[i] === 'number');

function numericColumn(data, name, what, hint = '') {
  const i = data.columns.indexOf(name);
  if (i < 0) fail(`Unknown ${what} column “${String(name).slice(0, 60)}”. Available columns: ${shown(data.columns)}.`);
  if (data.types[i] !== 'number') fail(`${what[0].toUpperCase()}${what.slice(1)} column “${name}” must be numeric, but it is read as text. Numeric columns: ${shown(numericNames(data))}.${hint ? ` ${hint}` : ''}`);
  return i;
}

function columnList(data, raw, min, max, what, hint = '', flags = false) {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) fail(`${what} takes ${min} to ${max} numeric columns${Array.isArray(raw) ? `, got ${raw.length}` : ''}. Pass "columns" as an array of names. Numeric columns: ${shown(numericNames(data))}.`);
  if (new Set(raw).size !== raw.length) fail(`${what} columns must be different.`);
  return raw.map(name => {
    const i = data.columns.indexOf(name);
    // A yes/no text column can be read as 0/1 (correlate): yes = 1.
    if (flags && i >= 0 && data.types[i] === 'text') { const flag = binaryFlags(data, i); if (flag) return { name, index: i, flag }; }
    return { name, index: numericColumn(data, name, what, hint) };
  });
}

/** Same filter contract as structured queries: eq / gte / lte, at most 10, typed to the column. */
const valueIndex = new WeakMap();
/**
 * The distinct values of a text column, most frequent first: from every row of an in-memory table, or (for a large DuckDB
 * table, where the rows are a sample) from the profile when the column has few values. null when they cannot be known.
 */
export function distinctValues(data, column) {
  const i = data.columns.indexOf(column);
  if (i < 0 || data.types[i] !== 'text') return null;
  if (data.duck) { const known = data.duck.profile?.find(c => c.name === column)?.values; return Array.isArray(known) ? { list: known, set: new Set(known), distinct: known.length } : null; }
  if (!valueIndex.has(data)) valueIndex.set(data, new Map());
  const cache = valueIndex.get(data);
  if (!cache.has(column)) {
    const counts = new Map();
    for (const r of data.rows) if (r[i] !== null) counts.set(r[i], (counts.get(r[i]) ?? 0) + 1);
    const list = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([v]) => v);
    cache.set(column, { list: list.slice(0, 20), set: new Set(list), distinct: list.length });
  }
  return cache.get(column);
}

/** An equality filter on a text column must name a value the column has: "true" is not "yes". */
export function checkFilterValue(data, column, op, value) {
  if (op !== 'eq' || typeof value !== 'string') return;
  const known = distinctValues(data, column);
  if (!known || known.set.has(value)) return;
  const hint = known.list.find(v => String(v).toLowerCase() === value.toLowerCase());
  fail(`value ‘${value.slice(0, 60)}’ not found in ${column}; values: ${known.list.map(v => String(v).slice(0, 40)).join(', ')}${known.distinct > known.list.length ? `, … (${known.distinct} distinct)` : ''}${hint ? `. Did you mean ‘${hint}’?` : ''}`);
}

export function filterRows(data, raw = []) {
  if (!Array.isArray(raw)) fail('Filters must be an array.');
  if (raw.length > 10) fail('At most 10 filters.');
  const filters = raw.map(f => {
    if (!object(f) || !data.columns.includes(f.column) || !['eq', 'gte', 'lte'].includes(f.op)) fail('Invalid filter column or operator.');
    if (!['string', 'number'].includes(typeof f.value) || (typeof f.value === 'number' && !Number.isFinite(f.value))) fail('Invalid filter value.');
    const i = data.columns.indexOf(f.column);
    if ((data.types[i] === 'number') !== (typeof f.value === 'number')) fail('Filter value type does not match its column.');
    checkFilterValue(data, f.column, f.op, f.value);
    return { i, op: f.op, value: f.value };
  });
  const rows = data.rows.filter(r => filters.every(({ i, op, value }) => {
    const v = r[i];
    if (v === null) return false;
    return op === 'eq' ? v === value : op === 'gte' ? v >= value : v <= value;
  }));
  return { rows, filters: raw };
}

function groupRows(data, rows, groupBy, max = 30) {
  if (groupBy === undefined || groupBy === null) return [[null, rows]];
  const g = data.columns.indexOf(groupBy);
  if (g < 0) fail(`Unknown group column “${String(groupBy).slice(0, 60)}”. Available columns: ${shown(data.columns)}.`);
  const groups = new Map();
  for (const r of rows) {
    const key = r[g];
    if (key === null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  if (groups.size > max) fail(`"${groupBy}" has ${groups.size} groups; statistics by group allow at most ${max}. Filter first or choose a column with fewer values.`);
  return [...groups].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true }));
}

// ---------------------------------------------------------------- math

export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * p, lo = Math.floor(h);
  return lo + 1 < sorted.length ? sorted[lo] + (h - lo) * (sorted[lo + 1] - sorted[lo]) : sorted[lo];
}

export function describe(values) {
  const n = values.length;
  if (!n) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const m2 = values.reduce((a, v) => a + (v - mean) ** 2, 0);
  const variance = n > 1 ? m2 / (n - 1) : null;
  const std = variance === null ? null : Math.sqrt(variance);
  const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75), iqr = q3 - q1;
  const low = q1 - 1.5 * iqr, high = q3 + 1.5 * iqr;
  let skewness = null;
  if (n > 2 && std > 0) skewness = (n / ((n - 1) * (n - 2))) * values.reduce((a, v) => a + ((v - mean) / std) ** 3, 0);
  if (skewness !== null && Math.abs(skewness) < 1e-12) skewness = 0;
  if (!Number.isFinite(sum) || !Number.isFinite(m2)) fail('Numeric overflow. Rescale the source values.');
  return {
    n, sum: round(sum), mean: round(mean), median: round(quantile(sorted, 0.5)), std: round(std), variance: round(variance),
    min: round(sorted[0]), p1: round(quantile(sorted, 0.01)), p5: round(quantile(sorted, 0.05)), p10: round(quantile(sorted, 0.1)), q1: round(q1),
    q3: round(q3), p90: round(quantile(sorted, 0.9)), p95: round(quantile(sorted, 0.95)), p99: round(quantile(sorted, 0.99)), max: round(sorted[n - 1]),
    range: round(sorted[n - 1] - sorted[0]), iqr: round(iqr), cv: mean !== 0 && std !== null ? round(std / Math.abs(mean)) : null, skewness: round(skewness),
    mean_minus_median: round(mean - quantile(sorted, 0.5)),
    outliers: { count: values.filter(v => v < low || v > high).length, below: round(low), above: round(high), rule: '1.5 × IQR' },
    extreme_z: std > 0 ? values.filter(v => Math.abs(v - mean) / std > 3).length : 0,
  };
}

function pearsonOf(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return { r: null, mx, my, sxx, sxy };
  return { r: Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy))), mx, my, sxx, sxy };
}

/** Ranks with ties sharing their average rank (1-based). */
export function ranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k][1]] = rank;
    i = j + 1;
  }
  return out;
}

function lgamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function betacf(a, b, x) {
  const EPS = 3e-14, FPMIN = 1e-300;
  let c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}

/** Two-sided p-value for a correlation coefficient r from n pairs (t-test with n − 2 df). */
export function correlationPValue(r, n) {
  if (r === null || n < 3) return null;
  if (Math.abs(r) >= 1) return 0;
  const df = n - 2, t2 = r * r * df / (1 - r * r);
  return incompleteBeta(df / (df + t2), df / 2, 0.5);
}

export function strength(r) {
  if (r === null) return null;
  const a = Math.abs(r);
  const size = a < 0.1 ? 'negligible' : a < 0.3 ? 'weak' : a < 0.5 ? 'moderate' : a < 0.7 ? 'strong' : 'very strong';
  return a < 0.1 ? size : `${size} ${r > 0 ? 'positive' : 'negative'}`;
}

function correlatePair(xs, ys) {
  const n = xs.length;
  if (n < 3) return { n, pearson: null, spearman: null, reason: 'Fewer than 3 rows have both values.' };
  const p = pearsonOf(xs, ys);
  if (p.r === null) return { n, pearson: null, spearman: null, reason: 'One of the columns is constant over these rows.' };
  const s = pearsonOf(ranks(xs), ranks(ys));
  return {
    n,
    pearson: { r: round(p.r), r2: round(p.r * p.r), p_value: round(correlationPValue(p.r, n)), strength: strength(p.r) },
    spearman: s.r === null ? null : { rho: round(s.r), p_value: round(correlationPValue(s.r, n)), strength: strength(s.r) },
  };
}

function pairs(rows, xi, yi) {
  const xs = [], ys = [];
  for (const r of rows) if (r[xi] !== null && r[yi] !== null) { xs.push(r[xi]); ys.push(r[yi]); }
  return [xs, ys];
}

// ---------------------------------------------------------------- tools

export function statisticsTool(data, args = {}) {
  if (!object(args)) fail('Tool arguments must be an object.');
  const columns = columnList(data, args.columns, 1, 10, 'statistics', 'Statistics describe numeric columns; to compare a metric across a text column use compare_groups.');
  const { rows } = filterRows(data, args.filters ?? []);
  const groups = groupRows(data, rows, args.groupBy);
  return {
    matchedRows: rows.length,
    groupBy: args.groupBy ?? null,
    results: groups.map(([group, gRows]) => ({
      ...(args.groupBy ? { group } : {}),
      rows: gRows.length,
      columns: columns.map(c => {
        const values = gRows.map(r => r[c.index]).filter(v => v !== null);
        return { column: c.name, nulls: gRows.length - values.length, ...describe(values) };
      }),
    })),
    notes: ['std and variance are sample statistics (n − 1).', 'Quantiles use linear interpolation, like Excel PERCENTILE.INC.', 'Outliers use the 1.5 × IQR rule and extreme_z counts values more than 3 standard deviations from the mean; both are flags to inspect, not errors to delete.', 'When mean and median differ a lot (mean_minus_median), the data is skewed: report the median as the typical value.'],
  };
}

export function correlateTool(data, args = {}) {
  if (!object(args)) fail('Tool arguments must be an object.');
  const columns = columnList(data, args.columns, 2, 8, 'correlate', 'Correlate takes numeric columns, or a yes/no column (read as 1/0). To split by a text column pass it as groupBy (with exactly 2 numeric columns); to relate two text columns use crosstab_test; to test a metric across groups use compare_groups.', true);
  if (args.groupBy && columns.length !== 2) fail(`correlate by group takes exactly 2 numeric columns, got ${columns.length}. Call it once per pair, or drop groupBy.`);
  const filtered = filterRows(data, args.filters ?? []);
  // A yes/no column is read as 1 (yes) and 0 (no); a 0/1 column is one already. Pearson r between such a column and a measurement is the point-biserial correlation.
  const flagged = columns.filter(c => c.flag);
  const rows = flagged.length ? filtered.rows.map(r => { const c = r.slice(); for (const f of flagged) c[f.index] = c[f.index] === null ? null : f.flag(c[f.index]) ? 1 : 0; return c; }) : filtered.rows;
  for (const c of columns) c.binary = !!c.flag || !!binaryFlags(data, c.index);
  const methodOf = (a, b) => (a.binary && b.binary ? 'phi' : a.binary || b.binary ? 'point-biserial' : undefined);
  const coded = Object.fromEntries(flagged.map(f => { const seen = [...new Set(data.rows.map(r => r[f.index]).filter(v => v !== null))]; return [f.name, { one: seen.filter(f.flag), zero: seen.filter(v => !f.flag(v)) }]; }));
  const notes = [
    ...(columns.some(c => c.binary) ? [`Pearson r between a 0/1 (or yes/no) column and a measurement is the point-biserial correlation (the phi coefficient when both are 0/1)${flagged.length ? `; yes = 1, no = 0 for ${flagged.map(f => f.name).join(', ')}` : ''}.`] : []),
    'Correlation measures how two columns move together; it does not show that one causes the other.',
    'Pearson measures a straight-line relationship; Spearman measures any consistently rising or falling relationship and resists outliers.',
    'p_value below 0.05 is conventionally called statistically significant. Spearman p-values are approximate for fewer than 10 rows.',
  ];
  if (args.groupBy) {
    const [a, b] = columns;
    const groups = groupRows(data, rows, args.groupBy).map(([group, gRows]) => ({ group, ...correlatePair(...pairs(gRows, a.index, b.index)) }));
    return { matchedRows: rows.length, columns: [a.name, b.name], groupBy: args.groupBy, ...(methodOf(a, b) ? { method: methodOf(a, b) } : {}), ...(flagged.length ? { coded } : {}), groups, overall: correlatePair(...pairs(rows, a.index, b.index)), notes };
  }
  const results = [];
  for (let i = 0; i < columns.length; i++) {
    for (let j = i + 1; j < columns.length; j++) {
      results.push({ x: columns[i].name, y: columns[j].name, ...(methodOf(columns[i], columns[j]) ? { method: methodOf(columns[i], columns[j]) } : {}), ...correlatePair(...pairs(rows, columns[i].index, columns[j].index)) });
    }
  }
  results.sort((p, q) => Math.abs(q.pearson?.r ?? 0) - Math.abs(p.pearson?.r ?? 0));
  return { matchedRows: rows.length, ...(flagged.length ? { coded } : {}), pairs: results, strongest: results.find(p => p.pearson) ? { x: results[0].x, y: results[0].y, r: results[0].pearson?.r ?? null } : null, notes };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function linearTrendTool(data, args = {}) {
  if (!object(args)) fail('Tool arguments must be an object.');
  const yi = numericColumn(data, args.y, 'y');
  const xi = data.columns.indexOf(args.x);
  if (xi < 0) fail(`Unknown x column: ${String(args.x).slice(0, 100)}.`);
  if (xi === yi) fail('x and y must be different columns.');
  const { rows } = filterRows(data, args.filters ?? []);
  const isDate = data.types[xi] !== 'number';
  const xs = [], ys = [];
  let origin = null;
  for (const r of rows) {
    if (r[xi] === null || r[yi] === null) continue;
    let x = r[xi];
    if (isDate) {
      if (typeof x !== 'string' || !ISO_DATE.test(x) || Number.isNaN(Date.parse(x))) fail(`x column "${args.x}" must be numeric or ISO dates (YYYY-MM-DD).`);
      x = Date.parse(x) / 86_400_000;
    }
    xs.push(x); ys.push(r[yi]);
  }
  if (isDate && xs.length) { origin = Math.min(...xs); for (let i = 0; i < xs.length; i++) xs[i] -= origin; }
  const n = xs.length;
  if (n < 3) return { n, x: args.x, y: args.y, slope: null, reason: 'Fewer than 3 rows have both values.' };
  const p = pearsonOf(xs, ys);
  if (p.sxx === 0) return { n, x: args.x, y: args.y, slope: null, reason: 'x does not vary over these rows.' };
  const slope = p.sxy / p.sxx, intercept = p.my - slope * p.mx;
  const r = p.r ?? 0;
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const fit = (x) => intercept + slope * x;
  const label = (x) => isDate ? new Date((x + origin) * 86_400_000).toISOString().slice(0, 10) : round(x);
  return {
    n, x: args.x, y: args.y, x_kind: isDate ? 'date' : 'number',
    slope: round(slope), slope_unit: isDate ? `${args.y} per day` : `${args.y} per 1 ${args.x}`,
    ...(isDate ? { slope_per_30_days: round(slope * 30) } : {}),
    intercept: isDate ? null : round(intercept),
    r2: round(r * r), p_value: round(correlationPValue(p.r, n)), direction: slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat',
    fitted: { start: { x: label(xMin), y: round(fit(xMin)) }, end: { x: label(xMax), y: round(fit(xMax)) } },
    notes: ['Ordinary least squares on rows with both values. r2 is the share of variation in y explained by the straight line.', 'A trend describes the past rows only; it is not a forecast.'],
  };
}

// ---------------------------------------------------------------- cost efficiency (economies of scale)

/** Ordinary least squares y = a + b·x with standard errors. Needs n ≥ 3 and varying x. */
function olsFit(xs, ys) {
  const n = xs.length, p = pearsonOf(xs, ys);
  if (n < 3 || p.sxx === 0) return null;
  const b = p.sxy / p.sxx, a = p.my - b * p.mx, df = n - 2;
  let sse = 0, sst = 0;
  for (let i = 0; i < n; i++) { sse += (ys[i] - a - b * xs[i]) ** 2; sst += (ys[i] - p.my) ** 2; }
  const s = Math.sqrt(sse / df), seB = s / Math.sqrt(p.sxx), seA = s * Math.sqrt(1 / n + p.mx ** 2 / p.sxx);
  return { n, df, b, a, seB, seA, r2: sst === 0 ? null : 1 - sse / sst };
}
const interval = (est, se, df) => { const t = tCritical(df); return [round(est - t * se), round(est + t * se)]; };
const sig3 = (x) => Number(x.toPrecision(3));
const total = (xs) => xs.reduce((a, b) => a + b, 0);

/**
 * Fixed verdict rule with a practical threshold: scale effects count only when the whole 95% CI
 * clears 0.95 / 1.05. A CI that excludes 1 yet lies wholly inside 0.95–1.05 is "negligible in practice".
 */
export function scaleVerdict([lo, hi]) {
  const verdict = hi < 0.95 ? 'economies_of_scale' : lo > 1.05 ? 'diseconomies_of_scale' : 'roughly_proportional';
  return { verdict, negligible: verdict === 'roughly_proportional' && (hi < 1 || lo > 1) && lo >= 0.95 && hi <= 1.05 };
}

function elasticityOf(vol, cost) {
  const fit = olsFit(vol.map(Math.log), cost.map(Math.log));
  if (!fit) return null;
  const t = fit.seB === 0 ? (fit.b === 1 ? 0 : Infinity) : (fit.b - 1) / fit.seB;
  return { fit, ci: interval(fit.b, fit.seB, fit.df), p: Number.isFinite(t) ? tTwoSided(Math.abs(t), fit.df) : 0 };
}

export function costEfficiencyTool(data, args = {}) {
  if (!object(args)) fail('Tool arguments must be an object.');
  const vi = numericColumn(data, args.volume, 'volume'), ci = numericColumn(data, args.cost, 'cost');
  if (vi === ci) fail('volume and cost must be different columns.');
  const { rows } = filterRows(data, args.filters ?? []);
  const usable = (list) => list.filter(r => r[vi] !== null && r[ci] !== null && r[vi] > 0 && r[ci] > 0);
  const valid = usable(rows), vol = valid.map(r => r[vi]), cost = valid.map(r => r[ci]);
  const base = { volume: args.volume, cost: args.cost, n: valid.length, excluded: rows.length - valid.length, excluded_rule: 'null, zero or negative volume or cost' };
  if (valid.length < 3) return { ...base, reason: 'Fewer than 3 rows have positive volume and cost.' };
  const d = describe(valid.map(r => r[ci] / r[vi]));
  const lin = olsFit(vol, cost), el = elasticityOf(vol, cost);

  const sorted = [...vol].sort((a, b) => a - b);
  const cuts = [0.25, 0.5, 0.75].map(p => quantile(sorted, p));
  const bands = [[], [], [], []];
  for (const r of valid) { const k = cuts.findIndex(c => r[vi] <= c); bands[k === -1 ? 3 : k].push(r); }
  const by_volume_band = bands.filter(b => b.length).map(b => {
    const vs = b.map(r => r[vi]);
    return { volume_from: Math.min(...vs), volume_to: Math.max(...vs), n: b.length, total_volume: round(total(vs)), unit_cost: round(total(b.map(r => r[ci])) / total(vs)) };
  });

  let interpretation = { verdict: null, summary: 'Volume does not vary, so scale effects cannot be estimated.' };
  if (el) {
    const b = el.fit.b;
    const { verdict, negligible } = scaleVerdict(el.ci), factor = sig3(2 ** b);
    const text = { economies_of_scale: 'Economies of scale: cost grows slower than volume.', roughly_proportional: 'Roughly proportional: cost grows about as fast as volume.', diseconomies_of_scale: 'Diseconomies of scale: cost grows faster than volume.' }[verdict];
    const tail = negligible ? ` Statistically different from 1 but negligible in practice (2× volume → ${factor}× cost).` : ` Doubling volume multiplies cost by 2^${sig3(b)} = ${factor}.`;
    interpretation = { verdict, negligible, summary: `${text}${tail}`, doubling_volume_multiplies_cost_by: factor, rule: 'economies of scale only if the 95% CI upper bound < 0.95; diseconomies only if the lower bound > 1.05' };
  }

  let groups;
  if (args.groupBy !== undefined && args.groupBy !== null) {
    if (args.rank_groups_by !== undefined && !['unit_cost', 'n'].includes(args.rank_groups_by)) fail('rank_groups_by must be unit_cost or n.');
    const all = groupRows(data, rows, args.groupBy, 200).map(([key, list]) => {
      const g = usable(list), gv = g.map(r => r[vi]), gc = g.map(r => r[ci]);
      const e = g.length >= 8 ? elasticityOf(gv, gc) : null;
      return { group: key, n: g.length, unit_cost: g.length ? round(total(gc) / total(gv)) : null, elasticity: e ? round(e.fit.b) : null, elasticity_ci95: e ? e.ci : null, ...(e ? scaleVerdict(e.ci) : {}) };
    }).filter(g => g.n > 0).sort(args.rank_groups_by === 'n' ? (a, b) => b.n - a.n || a.unit_cost - b.unit_cost : (a, b) => a.unit_cost - b.unit_cost);
    groups = { by: args.groupBy, total: all.length, shown: Math.min(20, all.length), rows: all.slice(0, 20) };
  }

  return {
    ...base,
    unit_cost: { pooled: round(total(cost) / total(vol)), per_row: { median: d.median, q1: d.q1, q3: d.q3, min: d.min, max: d.max } },
    linear: lin ? { marginal_cost_per_unit: round(lin.b), marginal_ci95: interval(lin.b, lin.seB, lin.df), fixed_cost_per_row: round(lin.a), fixed_ci95: interval(lin.a, lin.seA, lin.df), r2: round(lin.r2) } : null,
    elasticity: el ? { b: round(el.fit.b), intercept_log: round(el.fit.a), ci95: el.ci, r2: round(el.fit.r2), p_value_b_equals_1: round(el.p), df: el.fit.df } : null,
    interpretation,
    by_volume_band,
    ...(groups ? { groups } : {}),
    notes: [
      'Observational data: a pattern in cost per unit is not proof that volume caused it.',
      'Rows with null, zero or negative volume or cost are excluded from every figure above, so free or zero-cost rows do not count towards unit cost.',
      'Outliers can move the fit; check the extremes with statistics before relying on it.',
      'Outside this data, check consolidation of shipments, carrier rates and distance, which often explain unit-cost differences.',
    ],
  };
}

// ---------------------------------------------------------------- distributions for hypothesis tests

function gammaSeries(a, x) {
  let sum = 1 / a, del = sum, ap = a;
  for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 3e-14) break; }
  return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
}
function gammaContinued(a, x) {
  const FPMIN = 1e-300;
  let b = x + 1 - a, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
/** Upper regularized gamma Q(a, x). */
function gammaQ(a, x) {
  if (x <= 0) return 1;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinued(a, x);
}
export const chiSquareSF = (x, df) => gammaQ(df / 2, x / 2);
/** Two-sided normal tail probability for |z|. */
export const normalTwoSided = (z) => gammaQ(0.5, (z * z) / 2);
/** Two-sided Student t p-value. */
export const tTwoSided = (t, df) => incompleteBeta(df / (df + t * t), df / 2, 0.5);
/** Upper tail of the F distribution. */
export const fSF = (f, d1, d2) => (f <= 0 ? 1 : incompleteBeta(d2 / (d2 + d1 * f), d2 / 2, d1 / 2));
/** Critical t for a two-sided interval (default 95%), by bisection on the CDF. */
export function tCritical(df, alpha = 0.05) {
  let lo = 0, hi = 1000;
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (tTwoSided(mid, df) > alpha) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
const tieTerm = (values) => { const counts = new Map(); for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1); let t = 0; for (const c of counts.values()) t += c ** 3 - c; return t; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sampleVar = (xs) => { const m = mean(xs); return xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1); };

// ---------------------------------------------------------------- compare_groups

const YES_VALUES = new Set(['yes', 'y', 'true', 'ya']), NO_VALUES = new Set(['no', 'n', 'false', 'tidak']);

/** A yes/no outcome: a 0/1 numeric column, or a text column holding only yes/no style values. Returns each value's event flag, or null. */
function binaryFlags(data, index) {
  const seen = new Set();
  for (const r of data.rows) if (r[index] !== null) { seen.add(r[index]); if (seen.size > 2) return null; }
  if (!seen.size) return null;
  if (data.types[index] === 'number') return [...seen].every(v => v === 0 || v === 1) ? (v => v === 1) : null;
  const lower = [...seen].map(v => String(v).trim().toLowerCase());
  return lower.every(v => YES_VALUES.has(v) || NO_VALUES.has(v)) ? (v => YES_VALUES.has(String(v).trim().toLowerCase())) : null;
}

/** Pearson chi-squared test on the k x 2 table of events and non-events per group (no continuity correction, as in crosstab_test). */
function proportionTest(groups) {
  const N = groups.reduce((s, g) => s + g.n, 0), E = groups.reduce((s, g) => s + g.events, 0), overall = E / N;
  let chi = 0, small = 0;
  for (const g of groups) for (const [observed, expected] of [[g.events, g.n * overall], [g.n - g.events, g.n * (1 - overall)]]) { if (expected > 0) chi += (observed - expected) ** 2 / expected; if (expected < 5) small++; }
  const df = groups.length - 1, p = overall === 0 || overall === 1 ? null : chiSquareSF(chi, df);
  return { N, E, overall, chi, df, p, small, v: p === null ? null : Math.sqrt(chi / N) };
}

/** compare_groups for a yes/no outcome: rate per group as %, and a chi-squared test of proportions. */
function compareProportions(data, args, vi, gi, flag) {
  const { rows } = filterRows(data, args.filters ?? []);
  const wanted = args.groups === undefined || args.groups === null ? null : args.groups;
  if (wanted !== null && (!Array.isArray(wanted) || wanted.length < 2 || wanted.length > 10)) fail('groups lists 2 to 10 group values to compare.');
  const buckets = new Map();
  for (const r of rows) {
    const key = r[gi], v = r[vi];
    if (key === null || v === null || (wanted && !wanted.includes(key))) continue;
    if (!buckets.has(key)) buckets.set(key, { n: 0, events: 0 });
    const b = buckets.get(key); b.n++; if (flag(v)) b.events++;
  }
  if (buckets.size > 10) fail(`"${args.groupBy}" has ${buckets.size} groups; compare at most 10. Pass groups to choose them, or filter first.`);
  const groups = [...buckets].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true }));
  if (groups.length < 2) fail('compare_groups needs at least 2 groups with values.');
  const { N, E, overall, chi, df, p, small } = proportionTest(groups.map(([, g]) => g));
  const pct = x => round(x * 100);
  const summary = groups.map(([group, g]) => ({ group, n: g.n, events: g.events, rate_pct: pct(g.events / g.n) }));
  const out = {
    column: args.column, groupBy: args.groupBy, outcome: 'yes/no', test: `${groups.length} groups, chi-squared test of proportions`,
    groups: summary, overall: { n: N, events: E, rate_pct: pct(overall) },
    chi_squared: { statistic: round(chi), df, p_value: p === null ? null : round(p), cramers_v: p === null ? null : round(Math.sqrt(chi / N)) },
    verdict: p === null ? 'Every row has the same outcome, so there is nothing to test.' : p < 0.05 ? `The rates differ by group (${pPhrase(p)}, below 0.05: statistically significant).` : `No statistically significant difference in rates (${pPhrase(p)}, not below 0.05).`,
    ...(small ? { warning: `${small} cell(s) expect fewer than 5 rows; the chi-squared p-value may be unreliable. Combine small groups.` } : {}),
    notes: ['The outcome column holds yes/no (or 1/0) values, so groups are compared by the share of yes (1), in %, not by a mean. The test is a chi-squared test of proportions (no continuity correction).', 'p_value below 0.05 is conventionally called statistically significant; also judge whether the difference in rates is large enough to matter.'],
  };
  if (groups.length === 2) {
    const [[ga, a], [gb, b]] = groups, pa = a.events / a.n, pb = b.events / b.n, se = Math.sqrt(pa * (1 - pa) / a.n + pb * (1 - pb) / b.n);
    out.difference = { of: `${ga} − ${gb}`, percentage_points: round((pa - pb) * 100), ci95_percentage_points: [round((pa - pb - 1.96 * se) * 100), round((pa - pb + 1.96 * se) * 100)], ...(pb > 0 ? { rate_ratio: round(pa / pb) } : {}) };
  }
  return out;
}

export function compareGroupsTool(data, args = {}) {
  if (!object(args)) fail('Tool arguments must be an object.');
  const bi = data.columns.indexOf(args.column), bg = data.columns.indexOf(args.groupBy);
  if (bi >= 0 && bg >= 0 && bi !== bg) {
    const flag = binaryFlags(data, bi);
    if (flag) return compareProportions(data, args, bi, bg, flag);
  }
  const vi = numericColumn(data, args.column, 'value');
  const gi = data.columns.indexOf(args.groupBy);
  if (gi < 0) fail('compare_groups needs a groupBy column.');
  if (gi === vi) fail('column and groupBy must be different.');
  const { rows } = filterRows(data, args.filters ?? []);
  const wanted = args.groups === undefined || args.groups === null ? null : args.groups;
  if (wanted !== null && (!Array.isArray(wanted) || wanted.length < 2 || wanted.length > 10)) fail('groups lists 2 to 10 group values to compare.');
  const buckets = new Map();
  for (const r of rows) {
    const key = r[gi], v = r[vi];
    if (key === null || v === null || (wanted && !wanted.includes(key))) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(v);
  }
  if (buckets.size > 10) fail(`"${args.groupBy}" has ${buckets.size} groups; compare at most 10. Pass groups to choose them, or filter first.`);
  const groups = [...buckets].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true }));
  if (groups.length < 2) fail('compare_groups needs at least 2 groups with values.');
  if (groups.some(([, v]) => v.length < 2)) fail('Every group needs at least 2 values; filter out tiny groups or choose groups explicitly.');
  const summary = groups.map(([group, v]) => { const d = describe(v); return { group, n: d.n, mean: d.mean, median: d.median, std: d.std, min: d.min, max: d.max }; });
  const notes = ['p_value below 0.05 is conventionally called statistically significant; also judge whether the difference is large enough to matter (effect size).', 'Rank-based tests (Mann–Whitney, Kruskal–Wallis) suit skewed data and outliers; mean-based tests (t-test, ANOVA) assume roughly normal groups.', 'These are observational comparisons: a difference between groups does not show its cause.'];
  if (groups.length === 2) {
    const [[ga, a], [gb, b]] = groups;
    const va = sampleVar(a), vb = sampleVar(b), sa = va / a.length, sb = vb / b.length;
    const diff = mean(a) - mean(b), se = Math.sqrt(sa + sb);
    const df = (sa + sb) ** 2 / (sa ** 2 / (a.length - 1) + sb ** 2 / (b.length - 1));
    const t = se > 0 ? diff / se : null;
    const crit = tCritical(df);
    const pooled = Math.sqrt(((a.length - 1) * va + (b.length - 1) * vb) / (a.length + b.length - 2));
    // Mann–Whitney U, normal approximation with tie and continuity correction (as scipy 'asymptotic').
    const all = [...a, ...b], rk = ranks(all), n1 = a.length, n2 = b.length, n = n1 + n2;
    const r1 = rk.slice(0, n1).reduce((x, y) => x + y, 0), u1 = r1 - n1 * (n1 + 1) / 2;
    const mu = n1 * n2 / 2, sigma = Math.sqrt(n1 * n2 / 12 * ((n + 1) - tieTerm(all) / (n * (n - 1))));
    const u = Math.max(u1, n1 * n2 - u1), z = sigma > 0 ? (u - mu - 0.5) / sigma : null;
    return {
      column: args.column, groupBy: args.groupBy, groups: summary, test: 'two groups',
      difference: { of: `${ga} − ${gb}`, mean_difference: round(diff), ci95: t === null ? null : [round(diff - crit * se), round(diff + crit * se)], cohens_d: pooled > 0 ? round(diff / pooled) : null },
      welch_t_test: t === null ? null : { t: round(t), df: round(df), p_value: round(tTwoSided(t, df)) },
      mann_whitney: z === null ? null : { u: round(u1), z: round(z), p_value: round(Math.min(1, normalTwoSided(z))) },
      notes,
    };
  }
  const k = groups.length, N = groups.reduce((s, [, v]) => s + v.length, 0), grand = groups.reduce((s, [, v]) => s + v.reduce((x, y) => x + y, 0), 0) / N;
  const ssb = groups.reduce((s, [, v]) => s + v.length * (mean(v) - grand) ** 2, 0);
  const ssw = groups.reduce((s, [, v]) => { const m = mean(v); return s + v.reduce((x, y) => x + (y - m) ** 2, 0); }, 0);
  const df1 = k - 1, df2 = N - k, F = ssw > 0 ? (ssb / df1) / (ssw / df2) : null;
  const all = groups.flatMap(([, v]) => v), rk = ranks(all);
  let offset = 0, hsum = 0;
  for (const [, v] of groups) { const rs = rk.slice(offset, offset + v.length).reduce((x, y) => x + y, 0); hsum += rs * rs / v.length; offset += v.length; }
  const tie = 1 - tieTerm(all) / (N ** 3 - N);
  const H = tie > 0 ? (12 / (N * (N + 1)) * hsum - 3 * (N + 1)) / tie : null;
  return {
    column: args.column, groupBy: args.groupBy, groups: summary, test: `${k} groups`,
    anova: F === null ? null : { f: round(F), df_between: df1, df_within: df2, p_value: round(fSF(F, df1, df2)), eta_squared: round(ssb / (ssb + ssw)) },
    kruskal_wallis: H === null ? null : { h: round(H), df: df1, p_value: round(chiSquareSF(H, df1)) },
    notes: [...notes, 'A significant result says at least one group differs, not which; compare specific pairs with groups: [a, b].'],
  };
}

// ---------------------------------------------------------------- crosstab_test

export function crosstabTool(data, args = {}) {
  if (!object(args)) fail('Tool arguments must be an object.');
  const ri = data.columns.indexOf(args.row), ci = data.columns.indexOf(args.column);
  if (ri < 0 || ci < 0) fail('crosstab_test needs existing row and column names.');
  if (ri === ci) fail('row and column must be different.');
  const { rows } = filterRows(data, args.filters ?? []);
  const rKeys = new Map(), cKeys = new Map(), counts = new Map();
  for (const r of rows) {
    const a = r[ri], b = r[ci];
    if (a === null || b === null) continue;
    rKeys.set(a, (rKeys.get(a) ?? 0) + 1); cKeys.set(b, (cKeys.get(b) ?? 0) + 1);
    const key = JSON.stringify([a, b]); counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (rKeys.size > 20 || cKeys.size > 20) fail('crosstab_test allows at most 20 distinct values per side; group or filter first.');
  if (rKeys.size < 2 || cKeys.size < 2) fail('Both sides need at least 2 distinct values.');
  const rs = [...rKeys.keys()].sort(), cs = [...cKeys.keys()].sort(), N = [...rKeys.values()].reduce((a, b) => a + b, 0);
  let chi = 0, small = 0;
  const table = rs.map(a => ({ [args.row]: a, ...Object.fromEntries(cs.map(b => {
    const observed = counts.get(JSON.stringify([a, b])) ?? 0, expected = rKeys.get(a) * cKeys.get(b) / N;
    chi += (observed - expected) ** 2 / expected; if (expected < 5) small++;
    return [String(b), observed];
  })) }));
  const df = (rs.length - 1) * (cs.length - 1);
  return {
    row: args.row, column: args.column, n: N, table,
    chi_squared: { statistic: round(chi), df, p_value: round(chiSquareSF(chi, df)), cramers_v: round(Math.sqrt(chi / (N * (Math.min(rs.length, cs.length) - 1)))) },
    ...(small ? { warning: `${small} cell(s) expect fewer than 5 rows; the chi-squared p-value may be unreliable. Combine rare categories.` } : {}),
    notes: ['Tests whether the two categories are associated (no Yates correction). Cramér’s V runs from 0 (no association) to 1 (complete).', 'Association is not causation.'],
  };
}

// ---------------------------------------------------------------- time_series

function periodKey(iso, period) {
  const day = iso.slice(0, 10);
  if (period === 'day') return day;
  if (period === 'month') return day.slice(0, 7);
  const d = new Date(`${day}T00:00:00Z`), dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - dow * 86_400_000).toISOString().slice(0, 10);
}

/** { column, value, before?, after? } for the event comparison, checked against the table. */
function eventSpec(data, raw) {
  if (raw === undefined || raw === null) return null;
  if (!object(raw) || typeof raw.column !== 'string') fail('event must be {column, value}: the column that marks the campaign and the value that means "on".');
  const index = data.columns.indexOf(raw.column);
  if (index < 0) fail(`Unknown event column “${String(raw.column).slice(0, 60)}”. Available columns: ${data.columns.slice(0, 60).join(', ')}.`);
  if (raw.value === undefined || raw.value === null || !['string', 'number'].includes(typeof raw.value)) fail('event needs a value: the cell value that marks a period as part of the event.');
  for (const k of ['before', 'after']) if (raw[k] !== undefined && (!Number.isInteger(raw[k]) || raw[k] < 1 || raw[k] > 60)) fail(`event.${k} must be a whole number of periods from 1 to 60.`);
  return { column: raw.column, index, value: String(raw.value), before: raw.before, after: raw.after };
}

/**
 * Pre / during / post around every event block. A block is a run of consecutive periods in which the event value
 * appears; its pre is the `before` periods (default: the window) right before it and its post the `after` periods
 * (default 1) right after it, leaving out periods that belong to any event. Lifts, the average across blocks and
 * pull_forward all follow the series metric (the sum or average of the value column, or the row count when there is no
 * value); the row count is returned next to them only as context. pull_forward is true when most of the blocks that can
 * be judged have a post clearly below their pre.
 */
function eventComparison(perPeriod, event, valueColumn, period, window, metric, windowed) {
  const measure = p => (metric === 'count' ? p.count : metric === 'sum' ? p.sum : p.n ? p.sum / p.n : null);
  const series = [...perPeriod].sort((a, b) => a[0].localeCompare(b[0])).map(([key, p]) => ({ period: key, ...p, metric: measure(p) }));
  const marked = series.map((p, i) => (p.hit ? i : -1)).filter(i => i >= 0);
  if (!marked.length) fail(`No period contains ${event.column} = ${event.value}. Check the exact value (case and spelling) with explore_data.`);
  const before = event.before ?? window, after = event.after ?? 1;
  const isEvent = new Set(marked);
  const runs = [];
  for (const i of marked) { const last = runs.at(-1); if (last && i === last.end + 1) last.end = i; else runs.push({ start: i, end: i }); }
  const avg = (items, field) => { const v = items.map(p => p[field]).filter(x => x !== null); return v.length ? round(mean(v)) : null; };
  const block = items => ({ periods: items.map(p => p.period), n_periods: items.length, avg_metric: avg(items, 'metric'), avg_count: avg(items, 'count') });
  const lift = (x, y) => (x === null || y === null || y === 0 ? null : round((x - y) / Math.abs(y) * 100));
  const blocks = runs.map(run => {
    const pre = series.slice(Math.max(0, run.start - before), run.start).filter((_, k, all) => !isEvent.has(run.start - all.length + k));
    const during = series.slice(run.start, run.end + 1), post = series.slice(run.end + 1, run.end + 1 + after).filter((_, k) => !isEvent.has(run.end + 1 + k));
    const preValues = pre.map(p => p.metric).filter(v => v !== null), postValues = post.map(p => p.metric).filter(v => v !== null);
    const preAvg = preValues.length ? mean(preValues) : null, postAvg = postValues.length ? mean(postValues) : null;
    // "Clearly below": more than one standard deviation of the pre periods (when there are three), and at least 5%.
    const margin = preAvg === null ? null : Math.max(preValues.length >= 3 ? Math.sqrt(sampleVar(preValues)) : 0, 0.05 * Math.abs(preAvg));
    return {
      event_periods: during.map(p => p.period),
      pre: block(pre), during: block(during), post: block(post),
      during_vs_pre_pct: { metric: lift(avg(during, 'metric'), avg(pre, 'metric')), count: lift(avg(during, 'count'), avg(pre, 'count')) },
      post_vs_pre_pct: { metric: lift(avg(post, 'metric'), avg(pre, 'metric')), count: lift(avg(post, 'count'), avg(pre, 'count')) },
      judged: preAvg !== null && postAvg !== null,
      pull_forward: preAvg !== null && postAvg !== null && postAvg < preAvg - margin,
    };
  });
  const mean2 = (values) => { const v = values.filter(x => x !== null); return v.length ? round(mean(v)) : null; };
  const average = {
    during_vs_pre_pct: { metric: mean2(blocks.map(b => b.during_vs_pre_pct.metric)), count: mean2(blocks.map(b => b.during_vs_pre_pct.count)) },
    post_vs_pre_pct: { metric: mean2(blocks.map(b => b.post_vs_pre_pct.metric)), count: mean2(blocks.map(b => b.post_vs_pre_pct.count)) },
  };
  const judged = blocks.filter(b => b.judged), dips = judged.filter(b => b.pull_forward).length;
  const label = metric === 'count' ? 'the number of rows' : `the ${metric} of ${valueColumn}`;
  return {
    column: event.column, value: event.value, period, metric, value_column: metric === 'count' ? null : valueColumn, n_blocks: blocks.length, blocks, average,
    blocks_with_pull_forward: dips, blocks_judged: judged.length,
    pull_forward: judged.length > 0 && dips * 2 > judged.length,
    notes: [
      `A period counts as part of the event when any of its rows has the event value. Lifts and pull_forward use ${label} per ${period}${metric === 'count' ? '' : '; the row count is given next to it (avg_count, count) only as context'}.`,
      `For each block, pre = the ${before} ${period}(s) right before it and post = the ${after} ${period}(s) right after it (periods that are themselves event periods are left out). Change them with event.before and event.after. average is the plain mean of the blocks.`,
      'pull_forward is true when most blocks have a post clearly below their pre (more than the pre-period spread and 5%): the campaign may have moved purchases earlier rather than created them. Compare during and post together before claiming a lift.',
      ...(windowed ? [`The data has more than 400 ${period}s, so only the periods around each event (before, during and after) were analysed.`] : []),
      ...(blocks.length > 1 ? [`${blocks.length} separate event blocks, each compared with its own surrounding periods.`] : []),
      ...(blocks.some(b => b.pre.n_periods < 3) ? ['A block has fewer than 3 periods before it: its baseline is thin.'] : []),
      ...(judged.length < blocks.length ? [`${blocks.length - judged.length} block(s) have no period after (or before) them in this data, so pull_forward cannot be judged for them.`] : []),
    ],
  };
}

/** Keeps only the periods around each event block (before, during, after) so a daily file does not hit the period limit. */
function restrictToEventWindows(buckets, perPeriod, event, window) {
  const keys = [...perPeriod.keys()].sort(), before = event.before ?? window, after = event.after ?? 1;
  const keep = new Set();
  let start = -1;
  const mark = (from, to) => { for (let i = Math.max(0, from - before); i <= Math.min(keys.length - 1, to + after); i++) keep.add(keys[i]); };
  keys.forEach((key, i) => {
    if (perPeriod.get(key).hit) { if (start < 0) start = i; } else if (start >= 0) { mark(start, i - 1); start = -1; }
  });
  if (start >= 0) mark(start, keys.length - 1);
  for (const key of keys) if (!keep.has(key)) { buckets.delete(key); perPeriod.delete(key); }
}

export function timeSeriesTool(data, args = {}) {
  if (!object(args)) fail('Tool arguments must be an object.');
  const di = data.columns.indexOf(args.date);
  if (di < 0) fail('time_series needs an existing date column.');
  const metric = args.metric ?? (args.value ? 'sum' : 'count');
  if (!['sum', 'avg', 'count'].includes(metric)) fail('metric must be sum, avg or count.');
  const vi = metric === 'count' ? -1 : numericColumn(data, args.value, 'value');
  const period = args.period ?? 'day';
  if (!['day', 'week', 'month'].includes(period)) fail('period must be day, week or month.');
  const window = args.window ?? { day: 7, week: 4, month: 3 }[period];
  if (!Number.isInteger(window) || window < 2 || window > 60) fail('window must be a whole number from 2 to 60.');
  const { rows } = filterRows(data, args.filters ?? []);
  const event = eventSpec(data, args.event);
  const buckets = new Map(), perPeriod = new Map();
  for (const r of rows) {
    const d = r[di];
    if (d === null) continue;
    if (typeof d !== 'string' || !ISO_DATE.test(d) || Number.isNaN(Date.parse(d.slice(0, 10)))) fail(`Date column "${args.date}" must hold ISO dates (YYYY-MM-DD).`);
    const key = periodKey(d, period);
    if (!buckets.has(key)) buckets.set(key, []);
    if (metric === 'count') buckets.get(key).push(1); else if (r[vi] !== null) buckets.get(key).push(r[vi]);
    if (event) {
      // Per period: the rows, and the sum and number of the value column, so the event follows the series metric.
      if (!perPeriod.has(key)) perPeriod.set(key, { count: 0, sum: 0, n: 0, hit: false });
      const p = perPeriod.get(key);
      p.count++;
      if (vi >= 0 && typeof r[vi] === 'number') { p.sum += r[vi]; p.n++; }
      if (String(r[event.index]) === event.value) p.hit = true;
    }
  }
  // In event mode a long daily series is cut down to the periods around each event, so day resolution is allowed.
  let windowed = false;
  if (event && buckets.size > 400) { restrictToEventWindows(buckets, perPeriod, event, window); windowed = true; }
  if (buckets.size > 400) fail(`${buckets.size} periods; at most 400${windowed ? ' even around the events' : ''}. Use a coarser period (week or month) or filter dates.`);
  const series = [...buckets].sort((a, b) => a[0].localeCompare(b[0])).map(([key, v]) => ({ period: key, value: metric === 'count' ? v.length : v.length ? (metric === 'sum' ? v.reduce((a, b) => a + b, 0) : mean(v)) : null }));
  const out = series.map((p, i) => {
    const prev = i > 0 ? series[i - 1].value : null;
    const trail = series.slice(Math.max(0, i - window + 1), i + 1).map(x => x.value).filter(v => v !== null);
    return {
      period: p.period, value: round(p.value),
      moving_avg: trail.length === Math.min(window, i + 1) && i + 1 >= window ? round(mean(trail)) : null,
      change: prev === null || p.value === null ? null : round(p.value - prev),
      change_pct: prev === null || p.value === null || prev === 0 ? null : round((p.value - prev) / Math.abs(prev) * 100),
    };
  });
  // Anomalies: distance from the average of the previous `window` periods, in standard deviations of those distances.
  const residuals = series.map((p, i) => {
    if (i < window || p.value === null) return null;
    const before = series.slice(i - window, i).map(x => x.value).filter(v => v !== null);
    return before.length === window ? p.value - mean(before) : null;
  });
  const valid = residuals.filter(v => v !== null);
  const sd = valid.length > 2 ? Math.sqrt(sampleVar(valid)) : 0;
  const anomalies = sd > 0 ? residuals.map((res, i) => (res !== null && Math.abs(res) > 2.5 * sd ? { period: series[i].period, value: round(series[i].value), expected: round(series[i].value - res), deviation_sd: round(res / sd) } : null)).filter(Boolean) : [];
  const first = series.find(p => p.value !== null), last = [...series].reverse().find(p => p.value !== null);
  return {
    date: args.date, value: metric === 'count' ? null : args.value, metric, period, window, periods: out.length, series: out.slice(-120),
    ...(out.length > 120 ? { shown: 'last 120 periods' } : {}),
    overall: first && last && first !== last ? { from: first.period, to: last.period, change: round(last.value - first.value), change_pct: first.value ? round((last.value - first.value) / Math.abs(first.value) * 100) : null } : null,
    anomalies,
    ...(event ? { event: eventComparison(perPeriod, event, args.value, period, window, metric, windowed) } : {}),
    notes: [`moving_avg is the trailing ${window}-${period} average. Periods with no rows are absent, not zero.`, 'Anomalies are periods more than 2.5 standard deviations from the trailing average: flags to investigate, not proof of a problem.', 'Compare like with like: for seasonal data use the same period last year.'],
  };
}

// ---------------------------------------------------------------- program effect (difference-in-differences)

const YES = new Set(['yes', 'y', 'true', 't', '1', 'ya']), NO = new Set(['no', 'n', 'false', 'f', '0', 'tidak']);
const flagOf = (v) => { if (v === null || v === undefined) return null; const s = String(v).trim().toLowerCase(); return YES.has(s) ? true : NO.has(s) ? false : undefined; };
const DAY_MS = 86_400_000;
const dayOf = (iso) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY_MS);
const addMonths = (day, k) => { const d = new Date(day * DAY_MS); return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, d.getUTCDate()) / DAY_MS); };
const monthOf = (day) => new Date(day * DAY_MS).toISOString().slice(0, 7);
const pct2 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const percentile = (sorted, p) => { const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };

/**
 * Did a program change what its members do? Difference-in-differences over units. A unit is treated from the first
 * row where the yes/no `treated` flag is yes. For every treated unit the average of `value` in the W months after that
 * date is compared with the W months before; units that never get the flag are measured over the same calendar
 * windows (one window per enrolment month), and the control change is subtracted. The 95% interval resamples units.
 */
export function programEffectTool(data, args = {}) {
  if (!object(args)) fail('Tool arguments must be an object.');
  const col = (name, what) => { const i = data.columns.indexOf(args[name]); if (i < 0) fail(`program_effect needs an existing ${what} column (${name}). Available columns: ${data.columns.slice(0, 60).join(', ')}.`); return i; };
  const ui = col('unit', 'unit (the customer or account id)'), di = col('date', 'date'), ti = col('treated', 'treated (yes/no)');
  const vi = numericColumn(data, args.value, 'value');
  const measure = args.measure ?? 'mean';
  if (!['mean', 'monthly_total'].includes(measure)) fail('measure must be mean (average value per row) or monthly_total (total per month, which also moves with how often a unit transacts).');
  const W = args.window_months ?? 3;
  if (!Number.isInteger(W) || W < 1 || W > 12) fail('window_months must be a whole number from 1 to 12.');
  if (new Set([ui, di, vi, ti]).size < 4) fail('program_effect needs four different columns: unit, date, value and treated.');
  // Optional: a column with each unit's actual start date (such as join_date). When given, the windows are anchored on it.
  let si = -1;
  if (args.start !== undefined && args.start !== null) {
    si = data.columns.indexOf(args.start);
    if (si < 0) fail(`Unknown start column “${String(args.start).slice(0, 60)}”. It must hold each unit's actual treatment start date. Available columns: ${data.columns.slice(0, 60).join(', ')}.`);
    if ([ui, di, vi, ti].includes(si)) fail('start must be a different column from unit, date, value and treated.');
  }
  const { rows } = filterRows(data, args.filters ?? []);

  const byUnit = new Map(), seenFlags = new Map(), startOf = new Map();
  let conflictingStarts = 0;
  let minDay = Infinity, maxDay = -Infinity, yesSum = 0, yesN = 0, noSum = 0, noN = 0;
  for (const r of rows) {
    const d = r[di], u = r[ui], v = r[vi];
    if (d === null || u === null || v === null) continue;
    if (typeof d !== 'string' || !ISO_DATE.test(d) || Number.isNaN(Date.parse(d.slice(0, 10)))) fail(`Date column "${args.date}" must hold ISO dates (YYYY-MM-DD).`);
    const flag = flagOf(r[ti]);
    if (flag === undefined) { seenFlags.set(String(r[ti]), 1); if (seenFlags.size > 8) break; continue; }
    if (flag === null) continue;
    const t = dayOf(d);
    minDay = Math.min(minDay, t); maxDay = Math.max(maxDay, t);
    const key = String(u);
    if (si >= 0 && r[si] !== null && r[si] !== '') {
      const s = r[si];
      if (typeof s !== 'string' || !ISO_DATE.test(s) || Number.isNaN(Date.parse(s.slice(0, 10)))) fail(`Start column "${args.start}" must hold ISO dates (YYYY-MM-DD); found “${String(s).slice(0, 40)}”.`);
      const day = dayOf(s), known = startOf.get(key);
      if (known === undefined) startOf.set(key, day); else if (known !== day) { conflictingStarts++; startOf.set(key, Math.min(known, day)); }
    }
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key).push({ t, v, f: flag });
    if (flag) { yesSum += v; yesN++; } else { noSum += v; noN++; }
  }
  if (seenFlags.size) fail(`Treated column "${args.treated}" must be a yes/no flag (yes/no, true/false, 1/0). Found other values: ${[...seenFlags.keys()].slice(0, 8).join(', ')}.`);
  if (!byUnit.size) fail('No usable rows: each row needs a unit, a date, a numeric value and a treated flag.');

  const treated = [], controls = [];
  let flippedBack = 0, startFallback = 0;
  for (const [id, list] of byUnit) {
    list.sort((a, b) => a.t - b.t);
    const first = list.find(x => x.f);
    if (si >= 0) {
      // The start column decides. A unit with a treated row but no start date falls back to its first treated row.
      if (startOf.has(id)) { treated.push({ id, list, enrol: startOf.get(id) }); continue; }
      if (first) { treated.push({ id, list, enrol: first.t }); startFallback++; continue; }
      controls.push({ id, list }); continue;
    }
    if (!first) { controls.push({ id, list }); continue; }
    if (list.some(x => !x.f && x.t > first.t)) flippedBack++;
    treated.push({ id, list, enrol: first.t });
  }
  const monthly = measure === 'monthly_total';
  // mean: the average value per row in the W months either side of the enrolment day (exact day windows).
  const level = (list, a, b) => {
    let n = 0, s = 0;
    for (const x of list) if (x.t >= a && x.t < b) { n++; s += x.v; }
    return n ? s / n : null;
  };
  const covered = (a, b) => a >= minDay && b - 1 <= maxDay;
  // monthly_total: whole calendar months. For a unit that first has the flag in month M, before = the W months ending the
  // month before M and after = the W months starting the month after M; the join month itself is left out, because the unit
  // joins at one of its own orders and that order would sit in the after window by construction. A month with no orders counts
  // as 0, for a unit with any order in those 2W months (units that do not buy around then are not part of the comparison).
  // The first and last month of the data may be partial, so no window uses them.
  const monthIndex = (day) => { const d = new Date(day * DAY_MS); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
  const firstFull = monthIndex(minDay) + 1, lastFull = monthIndex(maxDay) - 1;
  const monthTotals = (u) => { if (!u.months) { u.months = new Map(); for (const x of u.list) { const k = monthIndex(x.t); u.months.set(k, (u.months.get(k) ?? 0) + x.v); } } return u.months; };
  const monthLevels = (u, m) => {
    const totals = monthTotals(u);
    let pre = 0, post = 0, active = false;
    for (let k = m - W; k <= m - 1; k++) if (totals.has(k)) { pre += totals.get(k); active = true; }
    for (let k = m + 1; k <= m + W; k++) if (totals.has(k)) { post += totals.get(k); active = true; }
    return active ? { pre: pre / W, post: post / W } : null;
  };

  // Treated units with activity in the windows, which lie inside the data.
  const eligible = [], droppedWindow = { coverage: 0, inactive: 0 };
  for (const u of treated) {
    if (monthly) {
      const m = monthIndex(u.enrol);
      if (m - W < firstFull || m + W > lastFull) { droppedWindow.coverage++; continue; }
      const lv = monthLevels(u, m);
      if (!lv) { droppedWindow.inactive++; continue; }
      eligible.push({ ...u, pre: lv.pre, post: lv.post, delta: lv.post - lv.pre, month: m });
      continue;
    }
    const a = addMonths(u.enrol, -W), b = addMonths(u.enrol, W);
    if (!covered(a, b)) { droppedWindow.coverage++; continue; }
    const pre = level(u.list, a, u.enrol), post = level(u.list, u.enrol, b);
    if (pre === null || post === null) { droppedWindow.inactive++; continue; }
    eligible.push({ ...u, pre, post, delta: post - pre });
  }
  if (eligible.length < 2) fail(`program_effect needs at least 2 treated units with activity in the ${W} months before and after enrolment, inside the data${monthly ? ' (the join month and the first and last month of the data are not used)' : ''} (found ${eligible.length} of ${treated.length} treated units). Try a smaller window_months or check the treated column.`);
  if (controls.length < 2) fail(`program_effect needs at least 2 control units (units whose treated flag is never yes); found ${controls.length}. Without them the change cannot be separated from the calendar trend.`);

  // One calendar window per enrolment month. mean: centred on the median enrolment day of that month's treated units;
  // monthly_total: the very same calendar months for treated and control units.
  const cohorts = new Map();
  for (const u of eligible) { const k = monthly ? u.month : monthOf(u.enrol); if (!cohorts.has(k)) cohorts.set(k, []); cohorts.get(k).push(u); }
  const controlIndex = new Map(controls.map((c, i) => [c.id, i]));
  const cohortList = [...cohorts].map(([key, units]) => {
    const entries = [];
    if (monthly) {
      for (const c of controls) { const lv = monthLevels(c, key); if (lv) entries.push({ c: controlIndex.get(c.id), delta: lv.post - lv.pre, pre: lv.pre }); }
      return { key, units, entries };
    }
    const days = units.map(u => u.enrol).sort((a, b) => a - b), anchor = days[Math.floor(days.length / 2)];
    const a = addMonths(anchor, -W), b = addMonths(anchor, W);
    if (covered(a, b)) for (const c of controls) {
      const pre = level(c.list, a, anchor), post = level(c.list, anchor, b);
      if (pre !== null && post !== null) entries.push({ c: controlIndex.get(c.id), delta: post - pre, pre });
    }
    return { key, units, entries };
  });
  const usable = cohortList.filter(k => k.entries.length >= 1);
  const droppedNoControl = cohortList.filter(k => !k.entries.length).reduce((n, k) => n + k.units.length, 0);
  if (!usable.length) fail('No control unit has activity in the calendar windows around the enrolments, so there is nothing to compare with. Try a smaller window_months.');
  const unitsT = [];
  usable.forEach((k, ki) => { for (const u of k.units) unitsT.push({ delta: u.delta, pre: u.pre, post: u.post, cohort: ki }); });
  const cohortMean = (k, field) => k.entries.reduce((a, e) => a + e[field], 0) / k.entries.length;
  const cDelta = usable.map(k => cohortMean(k, 'delta')), cPre = usable.map(k => cohortMean(k, 'pre'));

  const avgT = (f) => unitsT.reduce((a, u) => a + f(u), 0) / unitsT.length;
  const tPre = avgT(u => u.pre), tPost = avgT(u => u.post), tChange = avgT(u => u.delta);
  const cChange = avgT(u => cDelta[u.cohort]), cPreLevel = avgT(u => cPre[u.cohort]);
  const did = tChange - cChange;
  const didPct = tPre ? did / tPre * 100 : null, beforeAfterPct = tPre ? tChange / tPre * 100 : null, controlPct = cPreLevel ? cChange / cPreLevel * 100 : null;
  const naivePct = yesN && noN && noSum ? ((yesSum / yesN) / (noSum / noN) - 1) * 100 : null;

  // Bootstrap over units: resample treated and control units with replacement, recompute everything.
  const rand = rng(42), B = 400, draws = [], drawsPct = [];
  const nT = unitsT.length, nC = controls.length;
  for (let b = 0; b < B; b++) {
    const wT = new Uint16Array(nT), wC = new Uint16Array(nC);
    for (let i = 0; i < nT; i++) wT[Math.floor(rand() * nT)]++;
    for (let i = 0; i < nC; i++) wC[Math.floor(rand() * nC)]++;
    const cd = usable.map(k => { let num = 0, den = 0; for (const e of k.entries) { const w = wC[e.c]; num += w * e.delta; den += w; } return den ? num / den : null; });
    let sumW = 0, sumD = 0, sumPre = 0;
    for (let i = 0; i < nT; i++) {
      const w = wT[i]; if (!w) continue;
      const c = cd[unitsT[i].cohort]; if (c === null) continue;
      sumW += w; sumD += w * (unitsT[i].delta - c); sumPre += w * unitsT[i].pre;
    }
    if (!sumW) continue;
    draws.push(sumD / sumW);
    if (sumPre) drawsPct.push(sumD / sumPre * 100);
  }
  draws.sort((a, b) => a - b); drawsPct.sort((a, b) => a - b);
  const ci = draws.length >= 50 ? [percentile(draws, 0.025), percentile(draws, 0.975)] : null;
  const ciPct = drawsPct.length >= 50 ? [percentile(drawsPct, 0.025), percentile(drawsPct, 0.975)] : null;
  // Without a start column the start is the first treated row, which is the unit's first order after it joined. For a
  // unit that orders only every few months that is well after the real start, so the months just before it hold no orders
  // by construction and a monthly total looks low before and high after.
  const inferredMonthly = monthly && si < 0;
  const startWarning = inferredMonthly ? 'Warning: no start column was given, so each unit\'s start is inferred from its first treated row. For units that order irregularly that row comes after the real join, so the months just before it are empty by construction and the before level is too low; a monthly_total effect can then be biased, often upward and by a lot. Use measure mean, or pass start: a column with each unit\'s actual join date.' : '';
  const measureText = measure === 'mean' ? `average value per row of ${args.value}` : `monthly total of ${args.value} (months with no orders count as 0)`;
  const sign = (x) => `${x >= 0 ? '+' : ''}${pct2(x)}%`;
  let verdict;
  if (!ciPct) verdict = 'The interval could not be computed (too few usable units), so no program effect is claimed.';
  else if (ciPct[0] > 0 || ciPct[1] < 0) {
    const comparison = beforeAfterPct !== null && Math.abs(beforeAfterPct) > Math.abs(didPct) ? `The simple before/after change of ${sign(beforeAfterPct)} overstates it because it includes the trend that control units also showed` : `The simple before/after change of ${sign(beforeAfterPct)} differs from it because it ignores what the control units did`;
    verdict = `Estimated program effect: ${sign(didPct)} on the ${measureText} (95% CI ${sign(ciPct[0])} to ${sign(ciPct[1])}), after removing the ${sign(controlPct)} change that control units showed over the same calendar windows. ${comparison}${naivePct === null ? '.' : `, and the naive enrolled-versus-not comparison of ${sign(naivePct)} mixes the effect with who chooses to enrol.`}`;
  } else verdict = `No clear program effect: the estimate is ${sign(didPct)} on the ${measureText} but the 95% CI (${sign(ciPct[0])} to ${sign(ciPct[1])}) includes 0. The simple before/after change was ${sign(beforeAfterPct)}, which the control units' change of ${sign(controlPct)} largely accounts for.`;
  if (startWarning) verdict = `${startWarning} ${verdict}`;
  return {
    unit: args.unit, date: args.date, value: args.value, treated: args.treated, measure, window_months: W, start: si >= 0 ? args.start : null,
    ...(startWarning ? { warnings: [startWarning] } : {}),
    n_units: { treated: nT, control: nC, treated_dropped: { outside_data: droppedWindow.coverage, inactive_in_window: droppedWindow.inactive, no_control_activity: droppedNoControl } },
    treated_change: { before: round(tPre), after: round(tPost), change: round(tChange), change_pct: pct2(beforeAfterPct) },
    control_change: { before: round(cPreLevel), after: round(cPreLevel + cChange), change: round(cChange), change_pct: pct2(controlPct), matched_windows: usable.length },
    did: { estimate: round(did), estimate_pct: pct2(didPct), ci95: ci && ci.map(round), ci95_pct: ciPct && ciPct.map(pct2), bootstrap: { draws: draws.length, resampled: 'units (treated and control)' } },
    simple_before_after_pct: pct2(beforeAfterPct), naive_pct: pct2(naivePct),
    verdict,
    notes: [
      ...(si >= 0 ? [`Each unit's start is the date in the ${args.start} column (anchoring the windows on the real start); the treated flag is used only for the naive comparison${startFallback ? `, and for ${startFallback} unit(s) with treated rows but no start date, whose first treated row is used instead` : ''}.`] : []),
      ...(conflictingStarts ? [`${conflictingStarts} row(s) give a unit a different start date from an earlier row; the earliest is used.`] : []),
      measure === 'mean' ? `Treated = ${si >= 0 ? 'from the start date' : 'from the first row where the treated flag is yes'}. Before and after are the same units, in the window months either side of that date; control units are measured over the same calendar windows (one per enrolment month).` : `Treated = ${si >= 0 ? 'from the start date' : 'from the first row where the treated flag is yes'}. Before = the ${W} full calendar month(s) ending the month before the join month, after = the ${W} starting the month after it; the join month and the first and last month of the data are not used. Months with no orders count as 0 for units that order at all in those months; control units are measured over the same calendar months.`,
      'Naive = average value of rows flagged yes versus rows flagged no. Those rows come from different units, so it includes selection effects (people who enrol differ from those who do not); the simple before/after change includes the calendar trend. Neither is the program effect.',
      'The estimate assumes treated and control units would have moved in parallel without the program. It is observational evidence, not proof of cause.',
      ...(flippedBack && si < 0 ? [`${flippedBack} unit(s) have a no row after their first yes; they are treated from the first yes.`] : []),
      `The 95% interval comes from ${draws.length} bootstrap resamples of units (fixed seed).`,
    ],
  };
}

// ---------------------------------------------------------------- churn

/**
 * Which units stopped? A unit is churned when its last row is more than `inactive_days` before the last date in the data.
 * It says nothing about a column such as a status or tier being "inactive": behaviour over time is the only definition used.
 * With group_by, units are grouped by the value they had on their latest row.
 */
export function churnTool(data, args = {}) {
  if (!object(args)) fail('Tool arguments must be an object.');
  const col = (name, what) => { const i = data.columns.indexOf(args[name]); if (i < 0) fail(`churn needs an existing ${what} column (${name}). Available columns: ${data.columns.slice(0, 60).join(', ')}.`); return i; };
  const ui = col('unit', 'unit (the customer or account id)'), di = col('date', 'date');
  const days = args.inactive_days ?? 90;
  if (!Number.isInteger(days) || days < 1 || days > 3650) fail('inactive_days must be a whole number from 1 to 3650.');
  let gi = -1;
  if (args.group_by !== undefined && args.group_by !== null) { gi = data.columns.indexOf(args.group_by); if (gi < 0) fail(`Unknown group_by column “${String(args.group_by).slice(0, 60)}”. Available columns: ${data.columns.slice(0, 60).join(', ')}.`); if (gi === ui || gi === di) fail('group_by must be a different column from unit and date.'); }
  const { rows } = filterRows(data, args.filters ?? []);
  const units = new Map();
  let lastDay = -Infinity, firstDay = Infinity;
  for (const r of rows) {
    const d = r[di], u = r[ui];
    if (d === null || u === null) continue;
    if (typeof d !== 'string' || !ISO_DATE.test(d) || Number.isNaN(Date.parse(d.slice(0, 10)))) fail(`Date column "${args.date}" must hold ISO dates (YYYY-MM-DD).`);
    const day = dayOf(d), key = String(u), prev = units.get(key), group = gi >= 0 ? r[gi] : null;
    lastDay = Math.max(lastDay, day); firstDay = Math.min(firstDay, day);
    // The group is the value on the unit's latest row (the first non-empty one when several rows share that day).
    if (!prev) units.set(key, { last: day, group });
    else if (day > prev.last) { prev.last = day; prev.group = group; }
    else if (day === prev.last && prev.group === null && group !== null) prev.group = group;
  }
  if (!units.size) fail('No usable rows: each row needs a unit and a date.');
  const cutoff = lastDay - days;
  if (cutoff <= firstDay) fail(`inactive_days = ${days} reaches back past the start of the data (${new Date(firstDay * DAY_MS).toISOString().slice(0, 10)} to ${new Date(lastDay * DAY_MS).toISOString().slice(0, 10)}), so no unit could be called churned. Use a smaller inactive_days.`);
  const buckets = new Map();
  let total = 0, churned = 0;
  for (const u of units.values()) {
    const key = gi < 0 ? 'all units' : u.group === null ? '(missing)' : String(u.group);
    if (!buckets.has(key)) buckets.set(key, { units: 0, churned: 0 });
    const b = buckets.get(key), gone = u.last < cutoff;
    b.units++; total++; if (gone) { b.churned++; churned++; }
  }
  if (buckets.size > 50) fail(`"${args.group_by}" has ${buckets.size} groups; at most 50. Filter or use a coarser column.`);
  const iso = day => new Date(day * DAY_MS).toISOString().slice(0, 10);
  const rate = (c, n) => round(c / n * 100);
  const groups = [...buckets].map(([group, b]) => ({ group, units: b.units, churned: b.churned, active: b.units - b.churned, churn_rate_pct: rate(b.churned, b.units) }))
    .sort((a, b) => a.churn_rate_pct - b.churn_rate_pct || String(a.group).localeCompare(String(b.group)));
  // With groups: do the churn rates really differ? Chi-squared on churned vs active units across the groups.
  const test = gi >= 0 && groups.length >= 2 ? proportionTest(groups.map(g => ({ n: g.units, events: g.churned }))) : null;
  return {
    unit: args.unit, date: args.date, inactive_days: days, group_by: gi >= 0 ? args.group_by : null,
    last_date: iso(lastDay), cutoff_date: iso(cutoff),
    definition: `A unit (${args.unit}) is churned when its last row (${args.date}) is more than ${days} days before the last date in the data (${iso(lastDay)}), that is, before ${iso(cutoff)}. Otherwise it is active.${gi >= 0 ? ` Units are grouped by their latest value of ${args.group_by}.` : ''}`,
    overall: { units: total, churned, active: total - churned, churn_rate_pct: rate(churned, total) },
    groups,
    ...(test ? {
      chi_squared: { statistic: round(test.chi), df: test.df, p_value: test.p === null ? null : round(test.p), cramers_v: test.v === null ? null : round(test.v) },
      verdict: test.p === null ? 'Every unit has the same outcome, so there is nothing to test.' : test.p < 0.05 ? `The churn rates differ by group (${pPhrase(test.p)}, below 0.05: statistically significant).` : `No statistically significant difference in churn rates between the groups (${pPhrase(test.p)}, not below 0.05).`,
      ...(test.small ? { warning: `${test.small} cell(s) expect fewer than 5 units; the chi-squared p-value may be unreliable. Combine small groups.` } : {}),
    } : {}),
    notes: [
      'Churn here is behaviour over time: no row for the unit in the last inactive_days. It does not use any status, tier or flag column as a proxy.',
      'A unit whose first row is recent has had little time to churn; compare groups with similar tenure before drawing conclusions.',
      ...(gi >= 0 ? ['Groups use each unit\'s latest value, so a unit that changed group is counted in the one it ended in.', 'chi_squared tests churned versus active units across the groups (Pearson, no continuity correction); p_value below 0.05 is conventionally called statistically significant.'] : []),
    ],
  };
}

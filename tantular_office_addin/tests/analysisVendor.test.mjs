// The vendored statistics engine: provenance pin plus the pure-statistics
// cases of upstream tests/dashboard-stats.test.mjs (ghifiardi/tantular-landing
// @ 0f87a306), run against the vendored copy. Upstream builds its fixtures
// with parseCSV; here they go through the add-in's Excel adapter instead, so
// the same reference values also prove the adapter types data like parseCSV.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chiSquareSF,
  compareGroupsTool,
  correlateTool,
  correlationPValue,
  crosstabTool,
  describe,
  incompleteBeta,
  linearTrendTool,
  normalTwoSided,
  quantile,
  ranks,
  statisticsTool,
  strength,
  tCritical,
  timeSeriesTool
} from "../src/vendor/tantular-dashboard/stats.mjs";
import { tableFromGrid } from "../src/chat/analysisTable.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED = path.join(ROOT, "src/vendor/tantular-dashboard/stats.mjs");
const PINNED_SHA256 = "d53cabe2981f189dff56af762fb4b978ce3e26e2b91e921c2e0e71f78a339b43";

const parseCSV = (text) => tableFromGrid(text.split("\n").map((line) => line.split(","))).data;
const close = (actual, expected, tol = 1e-6, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ""} expected ${expected}, got ${actual}`);

test("the vendored engine is byte-identical to the pinned upstream commit", () => {
  const sha = crypto.createHash("sha256").update(fs.readFileSync(VENDORED)).digest("hex");
  assert.equal(sha, PINNED_SHA256, "stats.mjs changed: re-vendor from upstream and update PROVENANCE.md");
  const provenance = fs.readFileSync(path.join(ROOT, "src/vendor/tantular-dashboard/PROVENANCE.md"), "utf8");
  assert.ok(provenance.includes(PINNED_SHA256));
  assert.ok(provenance.includes("0f87a306e6932173112e126d0eb89f0259653624"));
});

test("the vendored engine has no imports, network or eval: it can only compute", () => {
  const source = fs.readFileSync(VENDORED, "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|WebSocket|eval|Function)\s*\(/);
});

test("descriptive statistics match textbook values (sample std, PERCENTILE.INC quantiles, Excel SKEW)", () => {
  const d = describe([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(d.n, 10); assert.equal(d.sum, 55); assert.equal(d.mean, 5.5); assert.equal(d.median, 5.5);
  close(d.std, 3.0276503541); close(d.variance, 9.1666666667);
  assert.equal(d.q1, 3.25); assert.equal(d.q3, 7.75); close(d.p5, 1.45); close(d.p95, 9.55);
  assert.equal(d.skewness, 0); assert.equal(d.outliers.count, 0);
  close(describe([1, 2, 3, 10]).skewness, 1.763632615, 1e-8, "Excel SKEW(1,2,3,10)");
  assert.equal(describe([1, 2, 3, 4, 100]).outliers.count, 1);
  assert.deepEqual(describe([]), { n: 0 });
  assert.equal(describe([7]).std, null);
  assert.equal(quantile([10], 0.9), 10);
});

test("ranks share ties; p-values match published references", () => {
  assert.deepEqual(ranks([2, 4, 5, 4, 5]), [1, 2.5, 4.5, 2.5, 4.5]);
  close(correlationPValue(0.5, 20), 0.024769558, 1e-6, "r=0.5, n=20 (scipy.stats.pearsonr)");
  close(correlationPValue(0.7745966692, 5), 0.1240270, 1e-5, "r=0.775, n=5");
  assert.equal(correlationPValue(1, 10), 0);
  assert.equal(correlationPValue(0.3, 2), null);
  close(incompleteBeta(0.5, 2, 2), 0.5, 1e-12);
  assert.equal(strength(0.05), "negligible"); assert.equal(strength(-0.62), "strong negative"); assert.equal(strength(0.8), "very strong positive");
});

const sales = () => parseCSV([
  "date,region,revenue,orders,discount,code",
  "2026-10-01,Jakarta,100,10,5,001", "2026-10-02,Jakarta,120,12,4,002", "2026-10-03,Jakarta,140,15,3,003",
  "2026-10-04,Bandung,90,9,6,004", "2026-10-05,Bandung,110,10,5,005", "2026-10-06,Bandung,,11,4,006",
  "2026-10-07,Surabaya,150,16,2,007", "2026-10-08,Surabaya,170,18,1,008"
].join("\n"));

test("correlate: every pair, strongest first, nulls skipped pairwise, and plain-language notes", () => {
  const r = correlateTool(sales(), { columns: ["revenue", "orders", "discount"] });
  assert.equal(r.pairs.length, 3);
  assert.ok(Math.abs(r.pairs[0].pearson.r) >= Math.abs(r.pairs[2].pearson.r));
  const ro = r.pairs.find((p) => p.x === "revenue" && p.y === "orders");
  assert.equal(ro.n, 7, "the row with no revenue is left out of revenue pairs only");
  assert.ok(ro.pearson.r > 0.95 && ro.pearson.p_value < 0.01);
  assert.match(ro.pearson.strength, /very strong positive/);
  const rd = r.pairs.find((p) => p.x === "revenue" && p.y === "discount");
  assert.ok(rd.pearson.r < -0.9 && rd.spearman.rho < -0.9);
  assert.match(r.notes[0], /not show that one causes/);
  close(correlateTool(parseCSV("x,y\n1,2\n2,4\n3,5\n4,4\n5,5"), { columns: ["x", "y"] }).pairs[0].pearson.r, 0.7745966692, 1e-9);
});

test("correlate: by group, filters, constant and too-small inputs, and every refusal", () => {
  const g = correlateTool(sales(), { columns: ["revenue", "orders"], groupBy: "region" });
  assert.deepEqual(g.groups.map((x) => x.group), ["Bandung", "Jakarta", "Surabaya"]);
  assert.match(g.groups.find((x) => x.group === "Surabaya").reason, /Fewer than 3/);
  const f = correlateTool(sales(), { columns: ["revenue", "orders"], filters: [{ column: "region", op: "eq", value: "Jakarta" }] });
  assert.equal(f.matchedRows, 3);
  assert.match(correlateTool(parseCSV("a,b\n1,5\n2,5\n3,5"), { columns: ["a", "b"] }).pairs[0].reason, /constant/);
  for (const [args, re] of [
    [{ columns: ["revenue"] }, /2 to 8/], [{ columns: ["revenue", "region"] }, /must be numeric/], [{ columns: ["revenue", "revenue"] }, /different/],
    [{ columns: ["revenue", "nope"] }, /Unknown/], [{ columns: ["revenue", "orders", "discount"], groupBy: "region" }, /exactly 2/],
    [{ columns: ["revenue", "orders"], filters: [{ column: "region", op: "like", value: "J" }] }, /operator/],
    [{ columns: ["revenue", "orders"], filters: [{ column: "revenue", op: "gte", value: "100" }] }, /type does not match/]
  ]) assert.throws(() => correlateTool(sales(), args), re, JSON.stringify(args));
  const many = parseCSV(["k,v,w", ...Array.from({ length: 40 }, (_, i) => `g${i},${i},${i * 2}`)].join("\n"));
  assert.throws(() => correlateTool(many, { columns: ["v", "w"], groupBy: "k" }), /at most 30/);
});

test("statistics: per column and per group, with nulls counted separately", () => {
  const s = statisticsTool(sales(), { columns: ["revenue", "orders"] });
  const rev = s.results[0].columns[0];
  assert.equal(rev.nulls, 1); assert.equal(rev.n, 7); assert.equal(rev.sum, 880); close(rev.mean, 880 / 7);
  assert.equal(rev.min, 90); assert.equal(rev.max, 170); assert.equal(rev.median, 120);
  const byRegion = statisticsTool(sales(), { columns: ["revenue"], groupBy: "region" });
  assert.deepEqual(byRegion.results.map((r) => [r.group, r.columns[0].n, r.columns[0].mean]), [["Bandung", 2, 100], ["Jakarta", 3, 120], ["Surabaya", 2, 160]]);
  assert.throws(() => statisticsTool(sales(), { columns: ["code"] }), /must be numeric/, "leading-zero codes are text, not numbers");
  assert.throws(() => statisticsTool(sales(), { columns: [] }), /1 to 10/);
});

test("linear_trend: exact lines on numeric and ISO-date axes, with refusals", () => {
  const line = linearTrendTool(parseCSV("x,y\n1,3\n2,5\n3,7\n4,9"), { x: "x", y: "y" });
  assert.deepEqual([line.slope, line.intercept, line.r2, line.p_value, line.direction], [2, 1, 1, 0, "rising"]);
  const daily = linearTrendTool(parseCSV("day,sales\n2026-10-01,100\n2026-10-02,110\n2026-10-03,120\n2026-10-05,140"), { x: "day", y: "sales" });
  assert.deepEqual([daily.x_kind, daily.slope, daily.slope_per_30_days, daily.r2], ["date", 10, 300, 1]);
  assert.deepEqual(daily.fitted, { start: { x: "2026-10-01", y: 100 }, end: { x: "2026-10-05", y: 140 } });
  const t = linearTrendTool(sales(), { x: "date", y: "revenue" });
  assert.equal(t.n, 7); assert.equal(t.direction, "rising");
  assert.throws(() => linearTrendTool(sales(), { x: "region", y: "revenue" }), /ISO dates/);
  assert.match(linearTrendTool(parseCSV("x,y\n1,1\n1,2\n1,3"), { x: "x", y: "y" }).reason, /does not vary/);
});

// Reference values from upstream, produced with SciPy 1.18.1.
const A = [19.8, 20.4, 19.6, 17.8, 18.5, 18.9, 18.3, 18.9, 19.5, 22.0];
const B = [28.2, 26.6, 20.1, 23.3, 25.2, 22.1, 17.7, 27.6, 20.6, 13.7, 23.2, 17.5, 20.6, 18.0, 23.9, 21.6, 24.3, 20.4, 23.9, 13.3];
const C = [22.1, 23.4, 21.0, 24.5, 22.8, 23.9, 21.7, 22.6];
const groups = () => parseCSV("g,v\n" + [...A.map((v) => `A,${v}`), ...B.map((v) => `B,${v}`), ...C.map((v) => `C,${v}`)].join("\n"));

test("distribution helpers match SciPy", () => {
  close(tCritical(24.5), 2.0616718793474065, 1e-6);
  close(chiSquareSF(3.84, 1), 0.0500435, 1e-6);
  close(normalTwoSided(1.96), 0.0499958, 1e-6);
  const s = correlateTool(parseCSV("x,y\n1,2\n2,4\n3,5\n4,4\n5,5"), { columns: ["x", "y"] }).pairs[0].spearman;
  close(s.rho, 0.7378647873726218, 1e-8); close(s.p_value, 0.15461852312844926, 1e-6);
});

test("compare_groups: Welch t-test, Mann–Whitney, ANOVA and Kruskal–Wallis match SciPy", () => {
  const two = compareGroupsTool(groups(), { column: "v", groupBy: "g", groups: ["A", "B"] });
  close(two.welch_t_test.t, -2.225512039969852, 1e-8); close(two.welch_t_test.p_value, 0.035484530830010394, 1e-8);
  close(two.welch_t_test.df, 24.524634944257343, 1e-7);
  close(two.difference.ci95[0], -4.276458650120555, 1e-7); close(two.difference.ci95[1], -0.16354134987944358, 1e-7);
  close(two.difference.cohens_d, -0.6407644074250287, 1e-8);
  assert.equal(two.mann_whitney.u, 55.5); close(two.mann_whitney.p_value, 0.05279379552204588, 1e-8);
  const three = compareGroupsTool(groups(), { column: "v", groupBy: "g" });
  close(three.anova.f, 2.818889843973849, 1e-8); close(three.anova.p_value, 0.07326832688851548, 1e-8);
  close(three.kruskal_wallis.h, 8.672824717993645, 1e-8); close(three.kruskal_wallis.p_value, 0.013083382584653205, 1e-8);
  assert.throws(() => compareGroupsTool(groups(), { column: "v", groupBy: "v" }), /different/);
  assert.throws(() => compareGroupsTool(groups(), { column: "v", groupBy: "g", groups: ["A"] }), /2 to 10/);
});

test("crosstab_test: chi-squared and Cramér’s V match SciPy", () => {
  const rows = [];
  [[12, 5, 9], [7, 14, 10]].forEach((row, i) => row.forEach((n, j) => { for (let k = 0; k < n; k++) rows.push(`r${i},c${j}`); }));
  const r = crosstabTool(parseCSV("row,col\n" + rows.join("\n")), { row: "row", column: "col" });
  assert.equal(r.n, 57); assert.equal(r.chi_squared.df, 2);
  close(r.chi_squared.statistic, 5.233250620347395, 1e-8); close(r.chi_squared.p_value, 0.0730489649335201, 1e-8);
  close(r.chi_squared.cramers_v, 0.3030039841191194, 1e-8);
});

test("time_series buckets periods, computes a trailing moving average and flags anomalies", () => {
  const ts = parseCSV("date,v\n" + Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")},${i === 15 ? 500 : 100 + i}`).join("\n"));
  const r = timeSeriesTool(ts, { date: "date", value: "v" });
  assert.equal(r.periods, 20); assert.equal(r.window, 7);
  assert.equal(r.series[5].moving_avg, null); assert.equal(r.series[6].moving_avg, 103);
  assert.deepEqual(r.anomalies.map((a) => a.period), ["2026-10-16"]);
  assert.throws(() => timeSeriesTool(ts, { date: "date", value: "v", period: "year" }), /period/);
});

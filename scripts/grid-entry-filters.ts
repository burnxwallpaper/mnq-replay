/**
 * One-off grid search: EntryFilters → Combined peakEquity (hist high).
 * Uses production buildLong/Short + runStrategyScript + summarizeMultiBacktest.
 * Session Intl is precomputed once (Chicago 09:00–20:29 + Fri no entries from 14:45 CT) for speed; metrics match production.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildLongStrategyScript,
  buildShortStrategyScript,
  runStrategyScript,
  summarizeMultiBacktest,
  DEFAULT_ENTRY_FILTERS,
  STRATEGY_COLORS,
  type EntryFilters,
} from "../lib/strategy-script.ts";

type ResultRow = {
  bodyRatio: number;
  minBody: number;
  volLen: number;
  volMult: number;
  peakEquity: number;
  endingEquity: number;
  troughEquity: number;
  maxDrawdown: number;
  winRate: number | null;
  signalCount: number;
  closedTrades: number;
  phase: "coarse" | "refine" | "baseline";
};

const root = resolve(import.meta.dirname, "..");
const barsPath = resolve(root, "public/data/mnq-1m-bars.json");
const outPath = resolve(root, "scripts/grid-entry-filters-results.json");

const raw = JSON.parse(readFileSync(barsPath, "utf8")) as Array<{
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}>;
const bars = raw.map((b) => ({
  ts: b.t * 1000,
  o: b.o,
  h: b.h,
  l: b.l,
  c: b.c,
  v: b.v,
}));

const fmtParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Chicago",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
(globalThis as unknown as { __SESSION: boolean[] }).__SESSION = bars.map((b) => {
  const parts = fmtParts.formatToParts(new Date(b.ts));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const mins = h * 60 + m;
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  return mins >= 9 * 60 && mins < 21 * 60 - 30 && !(wd === "Fri" && mins >= 14 * 60 + 45);
});

function patchSession(src: string): string {
  const next = src.replace(
    /\/\/ SESSION_START=09:00 CT, SESSION_END=21:00 CT, ENTRY_CUTOFF_MINUTES_BEFORE_CLOSE=30 → last new entry before 20:30 CT; FRIDAY_ENTRY_CUTOFF=14:45 CT \(no new entries Fri >= 14:45\)\nconst ctParts = new Intl\.DateTimeFormat\("en-GB", \{ timeZone: "America\/Chicago", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" \}\)\.formatToParts\(new Date\(bar\.ts\)\)\nconst ctMins = Number\(ctParts\.find\(\(p\) => p\.type === "hour"\)\?\.value \?\? 0\) \* 60 \+ Number\(ctParts\.find\(\(p\) => p\.type === "minute"\)\?\.value \?\? 0\)\nconst ctWd = ctParts\.find\(\(p\) => p\.type === "weekday"\)\?\.value \?\? ""\nconst sessionOk = ctMins >= 9 \* 60 && ctMins < 21 \* 60 - 30 && !\(ctWd === "Fri" && ctMins >= 14 \* 60 \+ 45\)\n/,
    "const sessionOk = globalThis.__SESSION[i]\n",
  );
  if (next === src) {
    throw new Error("Failed to patch session Intl block — script template changed?");
  }
  return next;
}

function keyOf(f: EntryFilters): string {
  return `${f.bodyRatio}|${f.minBody}|${f.volLen}|${f.volMult}`;
}

function evaluate(filters: EntryFilters, phase: ResultRow["phase"]): ResultRow {
  const longSrc = patchSession(buildLongStrategyScript(filters));
  const shortSrc = patchSession(buildShortStrategyScript(filters));
  const longRun = runStrategyScript(bars, longSrc, "long");
  const shortRun = runStrategyScript(bars, shortSrc, "short");
  if (!longRun.ok || !shortRun.ok) {
    throw new Error(
      `Script failed for ${keyOf(filters)}: ${!longRun.ok ? longRun.error : shortRun.error}`,
    );
  }
  const report = summarizeMultiBacktest(
    [
      { id: "long", name: "Long", color: STRATEGY_COLORS.long, run: longRun },
      { id: "short", name: "Short", color: STRATEGY_COLORS.short, run: shortRun },
    ],
    bars,
  );
  if (!report) throw new Error("summarizeMultiBacktest returned null");
  const combined = report.series.find((s) => s.id === "combined");
  if (!combined) throw new Error("combined series missing");
  const closedTrades = [...longRun.trades, ...shortRun.trades].filter(
    (t) => t.exitIndex !== null,
  ).length;
  return {
    bodyRatio: filters.bodyRatio,
    minBody: filters.minBody,
    volLen: filters.volLen,
    volMult: filters.volMult,
    peakEquity: combined.peakEquity,
    endingEquity: combined.endingEquity,
    troughEquity: combined.troughEquity,
    maxDrawdown: report.stats.maxDrawdown,
    winRate: report.stats.winRate,
    signalCount: report.stats.signalCount,
    closedTrades,
    phase,
  };
}

function* cartesian<T>(axes: T[][]): Generator<T[]> {
  if (axes.length === 0) {
    yield [];
    return;
  }
  const [head, ...rest] = axes;
  for (const value of head) {
    for (const tail of cartesian(rest)) yield [value, ...tail];
  }
}

function uniqFilters(list: EntryFilters[]): EntryFilters[] {
  const seen = new Set<string>();
  const out: EntryFilters[] = [];
  for (const f of list) {
    const k = keyOf(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

function clampLikeProd(f: EntryFilters): EntryFilters {
  // Mirror clampFilters ranges so refine stays valid
  return {
    bodyRatio: Math.min(1, Math.max(0.05, f.bodyRatio)),
    minBody: Math.min(200, Math.max(0.25, f.minBody)),
    volLen: Math.min(200, Math.max(2, Math.round(f.volLen))),
    volMult: Math.min(20, Math.max(0.1, f.volMult)),
  };
}

function refineAround(winners: EntryFilters[]): EntryFilters[] {
  const out: EntryFilters[] = [];
  for (const w of winners) {
    const bodyRatios = [w.bodyRatio - 0.05, w.bodyRatio, w.bodyRatio + 0.05];
    const minBodies = [
      w.minBody - 1,
      w.minBody - 0.5,
      w.minBody,
      w.minBody + 0.5,
      w.minBody + 1,
    ];
    const volLens = [w.volLen - 5, w.volLen, w.volLen + 5];
    const volMults = [
      w.volMult - 0.2,
      w.volMult - 0.1,
      w.volMult,
      w.volMult + 0.1,
      w.volMult + 0.2,
    ];
    for (const combo of cartesian([bodyRatios, minBodies, volLens, volMults])) {
      const [bodyRatio, minBody, volLen, volMult] = combo as [
        number,
        number,
        number,
        number,
      ];
      out.push(
        clampLikeProd({
          bodyRatio: Math.round(bodyRatio * 1000) / 1000,
          minBody: Math.round(minBody * 100) / 100,
          volLen: Math.round(volLen),
          volMult: Math.round(volMult * 100) / 100,
        }),
      );
    }
  }
  return uniqFilters(out);
}

const COARSE_BODY = [0.35, 0.45, 0.55, 0.65, 0.75];
const COARSE_MIN = [2, 3, 4, 5, 6, 8];
const COARSE_VOL_LEN = [10, 15, 20, 30, 40];
const COARSE_VOL_MULT = [1.2, 1.5, 1.8, 2.2, 2.5, 3.0];

const coarseFilters: EntryFilters[] = [];
for (const combo of cartesian([COARSE_BODY, COARSE_MIN, COARSE_VOL_LEN, COARSE_VOL_MULT])) {
  const [bodyRatio, minBody, volLen, volMult] = combo as [number, number, number, number];
  coarseFilters.push({ bodyRatio, minBody, volLen, volMult });
}

const seen = new Set<string>();
const results: ResultRow[] = [];

function runPhase(filtersList: EntryFilters[], phase: ResultRow["phase"]) {
  let done = 0;
  const total = filtersList.length;
  const t0 = performance.now();
  for (const filters of filtersList) {
    const k = keyOf(filters);
    if (seen.has(k)) {
      done += 1;
      continue;
    }
    seen.add(k);
    const row = evaluate(filters, phase);
    results.push(row);
    done += 1;
    if (done % 50 === 0 || done === total) {
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      const best = [...results].sort((a, b) => b.peakEquity - a.peakEquity)[0];
      console.log(
        `[${phase}] ${done}/${total} (${elapsed}s) bestPeak=${best?.peakEquity} @ ${best ? keyOf(best) : "-"}`,
      );
    }
  }
}

console.log(`Bars: ${bars.length}`);
console.log(
  `Range: ${new Date(bars[0].ts).toISOString()} -> ${new Date(bars[bars.length - 1].ts).toISOString()}`,
);
console.log(`Coarse grid size: ${coarseFilters.length}`);

const baseline = evaluate(DEFAULT_ENTRY_FILTERS, "baseline");
seen.add(keyOf(DEFAULT_ENTRY_FILTERS));
results.push(baseline);
console.log("Baseline (default):", baseline);

runPhase(coarseFilters, "coarse");

const top3 = [...results]
  .sort((a, b) => b.peakEquity - a.peakEquity || b.endingEquity - a.endingEquity)
  .slice(0, 3)
  .map((r) => ({
    bodyRatio: r.bodyRatio,
    minBody: r.minBody,
    volLen: r.volLen,
    volMult: r.volMult,
  }));
console.log("Top 3 after coarse:", top3);

const refineList = refineAround(top3);
console.log(`Refine candidates (unique, incl. already seen): ${refineList.length}`);
runPhase(refineList, "refine");

results.sort((a, b) => b.peakEquity - a.peakEquity || b.endingEquity - a.endingEquity);

const best = results[0];
const top10 = results.slice(0, 10);
const payload = {
  generatedAt: new Date().toISOString(),
  barCount: bars.length,
  dateRange: {
    startIso: new Date(bars[0].ts).toISOString(),
    endIso: new Date(bars[bars.length - 1].ts).toISOString(),
    startTs: bars[0].ts,
    endTs: bars[bars.length - 1].ts,
  },
  startingNetAsset: 10_000,
  mnqPointValue: 2,
  defaultFilters: DEFAULT_ENTRY_FILTERS,
  baseline,
  best,
  top10,
  ranked: results,
  note: "Optimized Combined peakEquity (hist high) for Long+Short via summarizeMultiBacktest. Session filter uses precomputed Chicago 09:00–20:29 + Fri>=14:45 block identical to production Intl rule.",
};

writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log("\n=== BEST ===");
console.log(best);
console.log("\n=== BASELINE ===");
console.log(baseline);
console.log("\n=== TOP 10 ===");
for (const [i, row] of top10.entries()) {
  console.log(
    `${i + 1}. peak=${row.peakEquity} end=${row.endingEquity} dd=${row.maxDrawdown} wr=${row.winRate?.toFixed(4)} closed=${row.closedTrades} filters=${JSON.stringify({ bodyRatio: row.bodyRatio, minBody: row.minBody, volLen: row.volLen, volMult: row.volMult })} [${row.phase}]`,
  );
}
console.log(`\nWrote ${results.length} rows -> ${outPath}`);

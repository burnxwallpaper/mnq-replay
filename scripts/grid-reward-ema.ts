/**
 * Grid: base take-profit R × EMA→1R tighten ON/OFF.
 * Fixed: Combined long+short, filters 0.45/2/15/1.2, fee $1.6,
 * session CT 09:00–20:29, Fri ≥14:45 no new entries.
 * Does NOT change production defaults / Pages.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runStrategyScript,
  summarizeMultiBacktest,
  DEFAULT_ENTRY_FILTERS,
  STRATEGY_COLORS,
  type EntryFilters,
} from "../lib/strategy-script.ts";

type Combo = {
  rewardMultiple: number;
  emaTighten: boolean;
};

type ResultRow = Combo & {
  endingEquity: number;
  peakEquity: number;
  troughEquity: number;
  maxDrawdown: number;
  winRate: number | null;
  averageRr: number | null;
  closedTrades: number;
  maxConsecutiveLosses: number;
  medianHoldMs: number | null;
  averageHoldMs: number | null;
  longestHoldMs: number | null;
  note: string;
};

const root = resolve(import.meta.dirname, "..");
const barsPath = resolve(root, "public/data/mnq-1m-bars.json");
const outPath = resolve(root, "scripts/grid-reward-ema-results.json");

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

const filters: EntryFilters = DEFAULT_ENTRY_FILTERS;

function buildLong(rewardMultiple: number, emaTighten: boolean): string {
  const f = filters;
  const emaBlock = emaTighten
    ? `const ema5 = ta.ema(i, 5, "c")
if (position && position.side === "long" && bar.c < ema5) {
  return { target: position.entry + position.risk }
}
`
    : "";
  return `// GRID long R=${rewardMultiple} emaTighten=${emaTighten}
${emaBlock}const sessionOk = globalThis.__SESSION[i]
const avgVol = ta.sma(i, ${f.volLen}, "v")
const body = Math.abs(bar.c - bar.o)
const span = Math.max(bar.h - bar.l, 0.25)
if (!position && sessionOk && bar.c > bar.o && body / span >= ${f.bodyRatio} && body >= ${f.minBody} && bar.v > avgVol * ${f.volMult}) {
  const risk = Math.max(bar.c - bar.l, 1)
  return { signal: true, side: "long", stop: bar.l, target: bar.c + risk * ${rewardMultiple} }
}
return null
`;
}

function buildShort(rewardMultiple: number, emaTighten: boolean): string {
  const f = filters;
  const emaBlock = emaTighten
    ? `const ema5 = ta.ema(i, 5, "c")
if (position && position.side === "short" && bar.c > ema5) {
  return { target: position.entry - position.risk }
}
`
    : "";
  return `// GRID short R=${rewardMultiple} emaTighten=${emaTighten}
${emaBlock}const sessionOk = globalThis.__SESSION[i]
const avgVol = ta.sma(i, ${f.volLen}, "v")
const body = Math.abs(bar.c - bar.o)
const span = Math.max(bar.h - bar.l, 0.25)
if (!position && sessionOk && bar.c < bar.o && body / span >= ${f.bodyRatio} && body >= ${f.minBody} && bar.v > avgVol * ${f.volMult}) {
  const risk = Math.max(bar.h - bar.c, 1)
  return { signal: true, side: "short", stop: bar.h, target: bar.c - risk * ${rewardMultiple} }
}
return null
`;
}

function fmtHold(ms: number | null): string {
  if (ms === null) return "—";
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 48) return m ? `${h}h${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d${rh}h` : `${d}d`;
}

function evaluate(combo: Combo): ResultRow {
  const longSrc = buildLong(combo.rewardMultiple, combo.emaTighten);
  const shortSrc = buildShort(combo.rewardMultiple, combo.emaTighten);
  const longRun = runStrategyScript(bars, longSrc, "long");
  const shortRun = runStrategyScript(bars, shortSrc, "short");
  if (!longRun.ok || !shortRun.ok) {
    throw new Error(
      `Script failed R=${combo.rewardMultiple} ema=${combo.emaTighten}: ${
        !longRun.ok ? longRun.error : shortRun.error
      }`,
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
  const s = report.stats;
  let note = "";
  if (combo.rewardMultiple <= 1 && combo.emaTighten) {
    note = "EMA→1R redundant (base already ≤1R)";
  } else if (combo.rewardMultiple === 2 && combo.emaTighten) {
    note = "prior default 2R+EMA";
  } else if (combo.rewardMultiple === 1 && !combo.emaTighten) {
    note = "fixed 1R";
  } else if (combo.rewardMultiple === 2.5 && combo.emaTighten) {
    note = "CURRENT BASELINE";
  }
  return {
    ...combo,
    endingEquity: combined.endingEquity,
    peakEquity: combined.peakEquity,
    troughEquity: combined.troughEquity,
    maxDrawdown: s.maxDrawdown,
    winRate: s.winRate,
    averageRr: s.averageRr,
    closedTrades: s.closedTrades,
    maxConsecutiveLosses: s.maxConsecutiveLosses,
    medianHoldMs: s.medianHoldMs,
    averageHoldMs: s.averageHoldMs,
    longestHoldMs: s.longestHoldMs,
    note,
  };
}

const rewardMultiples = [1.0, 1.5, 2.0, 2.5, 3.0];
const combos: Combo[] = [];
for (const r of rewardMultiples) {
  for (const ema of [true, false]) {
    combos.push({ rewardMultiple: r, emaTighten: ema });
  }
}

const results: ResultRow[] = [];
for (const combo of combos) {
  const t0 = Date.now();
  const row = evaluate(combo);
  results.push(row);
  const wr = row.winRate === null ? "—" : `${(row.winRate * 100).toFixed(1)}%`;
  const rr = row.averageRr === null ? "—" : row.averageRr.toFixed(2);
  console.log(
    `R=${row.rewardMultiple.toFixed(1)} EMA=${row.emaTighten ? "ON " : "OFF"} | ` +
      `eq=$${row.endingEquity.toFixed(0)} peak=$${row.peakEquity.toFixed(0)} ` +
      `DD=$${row.maxDrawdown.toFixed(0)} wr=${wr} trades=${row.closedTrades} ` +
      `avgRR=${rr} maxCL=${row.maxConsecutiveLosses} ` +
      `hold med=${fmtHold(row.medianHoldMs)} avg=${fmtHold(row.averageHoldMs)} max=${fmtHold(row.longestHoldMs)}` +
      (row.note ? `  [${row.note}]` : "") +
      `  (${Date.now() - t0}ms)`,
  );
}

const byEquity = [...results].sort((a, b) => b.endingEquity - a.endingEquity);
const byDd = [...results].sort((a, b) => a.maxDrawdown - b.maxDrawdown);
const baseline = results.find((r) => r.rewardMultiple === 2.5 && r.emaTighten)!;

// Simple risk-adjusted: (ending - start) / maxDD ; start=10000
function radj(r: ResultRow): number {
  if (r.maxDrawdown <= 0) return Infinity;
  return (r.endingEquity - 10_000) / r.maxDrawdown;
}
const byRadj = [...results].sort((a, b) => radj(b) - radj(a));

const summary = {
  bars: bars.length,
  filters,
  feeUsd: 1.6,
  session: "CT 09:00–20:29; Fri ≥14:45 no new entries",
  results,
  rankByEndingEquity: byEquity.map((r, i) => ({
    rank: i + 1,
    label: `${r.rewardMultiple}R ${r.emaTighten ? "+EMA→1R" : "fixed"}`,
    endingEquity: r.endingEquity,
    maxDrawdown: r.maxDrawdown,
    riskAdj: radj(r),
  })),
  rankByMaxDD: byDd.map((r, i) => ({
    rank: i + 1,
    label: `${r.rewardMultiple}R ${r.emaTighten ? "+EMA→1R" : "fixed"}`,
    maxDrawdown: r.maxDrawdown,
    endingEquity: r.endingEquity,
  })),
  rankByRiskAdj: byRadj.map((r, i) => ({
    rank: i + 1,
    label: `${r.rewardMultiple}R ${r.emaTighten ? "+EMA→1R" : "fixed"}`,
    riskAdj: radj(r),
    endingEquity: r.endingEquity,
    maxDrawdown: r.maxDrawdown,
  })),
  baseline: {
    label: "2.5R + EMA→1R (default)",
    endingEquity: baseline.endingEquity,
    maxDrawdown: baseline.maxDrawdown,
    riskAdj: radj(baseline),
  },
  recommendation: (() => {
    const best = byRadj[0];
    const bestEq = byEquity[0];
    return {
      bestRiskAdj: `${best.rewardMultiple}R ${best.emaTighten ? "+EMA→1R" : "fixed"}`,
      bestEquity: `${bestEq.rewardMultiple}R ${bestEq.emaTighten ? "+EMA→1R" : "fixed"}`,
      vsBaselineNote:
        best.rewardMultiple === 2.5 && best.emaTighten
          ? "Current 2.5R+EMA→1R still best risk-adjusted among this grid."
          : `Best risk-adj is ${best.rewardMultiple}R ${best.emaTighten ? "+EMA→1R" : "fixed"} ` +
            `(eq $${best.endingEquity.toFixed(0)}, DD $${best.maxDrawdown.toFixed(0)}, radj ${radj(best).toFixed(2)}) ` +
            `vs baseline eq $${baseline.endingEquity.toFixed(0)}, DD $${baseline.maxDrawdown.toFixed(0)}, radj ${radj(baseline).toFixed(2)}.`,
    };
  })(),
};

writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log("\n=== Rank by ending equity ===");
for (const r of summary.rankByEndingEquity) {
  console.log(
    `#${r.rank} ${r.label.padEnd(16)} eq=$${r.endingEquity.toFixed(0).padStart(6)} DD=$${r.maxDrawdown.toFixed(0).padStart(5)} radj=${r.riskAdj.toFixed(2)}`,
  );
}
console.log("\n=== Rank by max DD (lower better) ===");
for (const r of summary.rankByMaxDD) {
  console.log(
    `#${r.rank} ${r.label.padEnd(16)} DD=$${r.maxDrawdown.toFixed(0).padStart(5)} eq=$${r.endingEquity.toFixed(0).padStart(6)}`,
  );
}
console.log("\n=== Rank by risk-adj (eq-10k)/DD ===");
for (const r of summary.rankByRiskAdj) {
  console.log(
    `#${r.rank} ${r.label.padEnd(16)} radj=${r.riskAdj.toFixed(2).padStart(6)} eq=$${r.endingEquity.toFixed(0).padStart(6)} DD=$${r.maxDrawdown.toFixed(0).padStart(5)}`,
  );
}
console.log("\nRecommendation:", summary.recommendation);
console.log("Wrote", outPath);

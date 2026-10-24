import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runStrategyScript,
  summarizeMultiBacktest,
  buildLongStrategyScript,
  buildShortStrategyScript,
  DEFAULT_ENTRY_FILTERS,
  STRATEGY_COLORS,
  DEFAULT_ROUND_TRIP_FEE_USD,
} from "../lib/strategy-script.ts";

const root = resolve(import.meta.dirname, "..");
const barsPath = resolve(root, "public/data/mnq-1m-bars.json");
const raw = JSON.parse(readFileSync(barsPath, "utf8"));
const bars = raw.map((b) => ({ ts: b.t * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
const filters = DEFAULT_ENTRY_FILTERS;
const longSrc = buildLongStrategyScript(filters);
const shortSrc = buildShortStrategyScript(filters);

function run(label, expiry) {
  const longRun = runStrategyScript(bars, longSrc, "long", { entryLimitExpiryBars: expiry });
  const shortRun = runStrategyScript(bars, shortSrc, "short", { entryLimitExpiryBars: expiry });
  if (!longRun.ok) throw new Error(longRun.error);
  if (!shortRun.ok) throw new Error(shortRun.error);
  const report = summarizeMultiBacktest(
    [
      { id: "long", name: "Long", color: STRATEGY_COLORS.long, run: longRun },
      { id: "short", name: "Short", color: STRATEGY_COLORS.short, run: shortRun },
    ],
    bars,
    DEFAULT_ROUND_TRIP_FEE_USD,
  );
  const c = report.series.find((s) => s.id === "combined");
  const s = report.stats;
  return {
    label,
    expiry,
    endingEquity: Math.round(c.endingEquity * 100) / 100,
    peakEquity: Math.round(c.peakEquity * 100) / 100,
    maxDrawdown: Math.round(s.maxDrawdown * 100) / 100,
    winRatePct: s.winRate == null ? null : Math.round(s.winRate * 1000) / 10,
    averageRr: s.averageRr == null ? null : Math.round(s.averageRr * 100) / 100,
    closedTrades: s.closedTrades,
    signals: s.signalCount,
    longestHoldMs: s.longestHoldMs,
  };
}

const before = run("instant fill (legacy)", 0);
const after = run("limit expiry 2 bars (new default)", 2);
console.log(JSON.stringify({ before, after }, null, 2));

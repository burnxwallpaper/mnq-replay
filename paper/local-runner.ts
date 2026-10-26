/**
 * Full-history local paper baseline — same engine as the web Combined backtest.
 * Usage: npx tsx paper/local-runner.ts
 *        npm run paper:local
 */
import { summarizeMultiBacktest, STRATEGY_COLORS } from "../lib/strategy-script.ts";
import {
  assertPaperSafe,
  formatMoney,
  loadBars,
  loadConfig,
  paperFlipLockBars,
} from "./forward-state.ts";
import { runPaperSides } from "./run-sides.ts";

function main() {
  const cfg = loadConfig();
  assertPaperSafe(cfg);
  const bars = loadBars();
  if (bars.length === 0) {
    console.error("No bars in public/data/mnq-1m-bars.json");
    process.exit(1);
  }

  let sides;
  try {
    sides = runPaperSides(cfg, bars);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const runs = sides.map((item) => ({
    id: item.id,
    name: item.id === "short" ? "Short" : "Long",
    color: item.id === "short" ? STRATEGY_COLORS.short : STRATEGY_COLORS.long,
    run: item.run,
  }));

  const report = summarizeMultiBacktest(runs, bars, cfg.roundTripFeeUsd);
  if (!report) {
    console.error("No report");
    process.exit(1);
  }
  const combined = report.series.find((s) => s.id === "combined") ?? report.series[0];
  const s = report.stats;

  console.log("=== MNQ local paper baseline (full history) ===");
  console.log(`Bars: ${bars.length}`);
  console.log(
    `Range: ${new Date(bars[0].ts).toISOString()} → ${new Date(bars[bars.length - 1].ts).toISOString()}`,
  );
  console.log(
    `Filters: bodyRatio=${cfg.filters.bodyRatio} minBody=${cfg.filters.minBody} volLen=${cfg.filters.volLen} volMult=${cfg.filters.volMult}`,
  );
  console.log(`Side: ${cfg.side} | fee/RT: $${cfg.roundTripFeeUsd} | point: $${cfg.pointValue}`);
  console.log(
    `Flip lock bars: ${paperFlipLockBars(cfg)} (config ${cfg.flipLockBars}; shared long+short when side=both; 0 = off)`,
  );
  console.log(`Starting equity: ${formatMoney(cfg.startingEquity)}`);
  console.log("---");
  console.log(`Ending equity:    ${formatMoney(combined.endingEquity)}`);
  console.log(`Peak (hist high): ${formatMoney(combined.peakEquity)}`);
  console.log(`Max drawdown:     ${formatMoney(s.maxDrawdown)}`);
  console.log(`Closed trades:    ${s.closedTrades}`);
  console.log(`Win rate:         ${s.winRate == null ? "n/a" : (s.winRate * 100).toFixed(2) + "%"}`);
  console.log(`Avg RR:           ${s.averageRr == null ? "n/a" : s.averageRr.toFixed(2) + " R"}`);
  console.log(`Total fees:       ${formatMoney(s.totalFees)}`);
  console.log(
    `Note: maxContracts=${cfg.maxContracts} (local fills are 1 contract each, matching the web backtest).`,
  );
}

main();

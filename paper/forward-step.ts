/**
 * Local forward paper: after you refresh mnq-1m-bars.json, re-run and book only
 * trades that closed on bars newer than state.lastProcessedBarTs.
 *
 * First run (no state): anchors at the latest bar (no historical dump).
 * Optional: --bootstrap  replay full history into the paper book once.
 *
 * Usage: npx tsx paper/forward-step.ts
 *        npx tsx paper/forward-step.ts --bootstrap
 *        npm run paper:forward
 */
import type { ScriptTrade } from "../lib/strategy-script.ts";
import {
  appendTrade,
  assertPaperSafe,
  formatMoney,
  loadBars,
  loadConfig,
  loadState,
  paperFlipLockBars,
  saveState,
  tradePoints,
  type ClosedPaperTrade,
  type OpenVirtualPosition,
} from "./forward-state.ts";
import { runPaperSides } from "./run-sides.ts";

function isClosed(
  trade: ScriptTrade,
): trade is ScriptTrade & {
  exitIndex: number;
  exitPrice: number;
  exitReason: "stop" | "target";
} {
  return trade.exitIndex !== null && trade.exitPrice !== null && trade.exitReason !== null;
}

function openFromTrade(
  trade: ScriptTrade,
  bars: ReturnType<typeof loadBars>,
  contracts: number,
): OpenVirtualPosition {
  return {
    strategyId: trade.strategyId,
    side: trade.side,
    entryTs: bars[trade.entryIndex].ts,
    entryPrice: trade.entryPrice,
    stopPrice: trade.stopPrice,
    targetPrice: trade.targetPrice,
    riskPoints: trade.riskPoints,
    contracts,
  };
}

function main() {
  const bootstrap = process.argv.includes("--bootstrap");
  const cfg = loadConfig();
  assertPaperSafe(cfg);
  const bars = loadBars();
  if (bars.length === 0) {
    console.error("No bars in public/data/mnq-1m-bars.json");
    process.exit(1);
  }

  const state = loadState(cfg);
  const lastTs = bars[bars.length - 1].ts;
  const firstInit = state.lastProcessedBarTs == null;

  if (firstInit && !bootstrap) {
    state.lastProcessedBarTs = lastTs;
    state.configSnapshot = {
      filters: cfg.filters,
      roundTripFeeUsd: cfg.roundTripFeeUsd,
      pointValue: cfg.pointValue,
      startingEquity: cfg.startingEquity,
      side: cfg.side,
      maxContracts: cfg.maxContracts,
      flipLockBars: cfg.flipLockBars,
    };
    saveState(state);
    console.log("=== MNQ local forward paper — initialized ===");
    console.log(`Anchored at latest bar ts=${lastTs} (${new Date(lastTs).toISOString()})`);
    console.log(`Equity: ${formatMoney(state.equity)} (starting)`);
    console.log("No historical trades booked. Refresh bars later, then re-run paper:forward.");
    console.log("Tip: use --bootstrap once if you want to seed the book from full history.");
    return;
  }

  const cutoff = bootstrap && firstInit ? -Infinity : (state.lastProcessedBarTs ?? -Infinity);

  const runs = runPaperSides(cfg, bars);
  const contracts = 1; // match web backtest fill size
  const newTrades: ClosedPaperTrade[] = [];

  for (const { run } of runs) {
    for (const trade of run.trades) {
      if (!isClosed(trade)) continue;
      const exitTs = bars[trade.exitIndex].ts;
      if (exitTs <= cutoff) continue;
      const points = tradePoints(trade.side, trade.entryPrice, trade.exitPrice) * contracts;
      const feeUsd = cfg.roundTripFeeUsd;
      const pnlUsd = points * cfg.pointValue - feeUsd;
      const row: ClosedPaperTrade = {
        strategyId: trade.strategyId,
        side: trade.side,
        entryTs: bars[trade.entryIndex].ts,
        exitTs,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        exitReason: trade.exitReason,
        riskPoints: trade.riskPoints,
        points,
        pnlUsd,
        feeUsd,
        contracts,
      };
      newTrades.push(row);
    }
  }

  newTrades.sort((a, b) => a.exitTs - b.exitTs || a.entryTs - b.entryTs);

  let equity = state.equity;
  let peak = state.peakEquity;
  let fees = state.totalFees;
  for (const trade of newTrades) {
    equity += trade.pnlUsd;
    fees += trade.feeUsd;
    if (equity > peak) peak = equity;
    appendTrade(trade);
  }

  const openPositions: OpenVirtualPosition[] = [];
  for (const { run } of runs) {
    for (const trade of run.trades) {
      if (trade.exitIndex !== null) continue;
      openPositions.push(openFromTrade(trade, bars, contracts));
    }
  }

  const newBarCount =
    cutoff === -Infinity
      ? bars.length
      : bars.filter((b) => b.ts > cutoff).length;

  state.equity = equity;
  state.peakEquity = peak;
  state.totalFees = fees;
  state.closedTradeCount += newTrades.length;
  state.openPositions = openPositions;
  state.lastProcessedBarTs = lastTs;
  state.configSnapshot = {
    filters: cfg.filters,
    roundTripFeeUsd: cfg.roundTripFeeUsd,
    pointValue: cfg.pointValue,
    startingEquity: cfg.startingEquity,
    side: cfg.side,
    maxContracts: cfg.maxContracts,
    flipLockBars: cfg.flipLockBars,
  };
  saveState(state);

  console.log("=== MNQ local forward paper — step ===");
  console.log(
    bootstrap && firstInit
      ? "Mode: bootstrap (full history seeded into paper book)"
      : `Mode: forward (cutoff ${new Date(cutoff).toISOString()})`,
  );
  console.log(`New bars since cutoff: ${newBarCount}`);
  console.log(`New closed trades:     ${newTrades.length}`);
  console.log(`Open positions:        ${openPositions.length}`);
  console.log(`Equity:                ${formatMoney(state.equity)}`);
  console.log(`Peak equity:           ${formatMoney(state.peakEquity)}`);
  console.log(`Total fees:            ${formatMoney(state.totalFees)}`);
  console.log(`Closed trade count:    ${state.closedTradeCount}`);
  console.log(`Last bar:              ${new Date(lastTs).toISOString()}`);
  console.log(
    `Flip lock bars:        ${paperFlipLockBars(cfg)} (config ${cfg.flipLockBars}; 0 = off; shared when side=both)`,
  );
  if (newTrades.length > 0) {
    console.log("--- latest new trades ---");
    for (const t of newTrades.slice(-5)) {
      console.log(
        `  ${t.strategyId} ${t.side} ${t.exitReason} pts=${t.points.toFixed(2)} pnl=${formatMoney(t.pnlUsd)} @ ${new Date(t.exitTs).toISOString()}`,
      );
    }
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

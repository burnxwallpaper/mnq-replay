import { runImpulsePullbackLong } from "./impulse-pullback-long";
import type {
  BookSnapshot,
  ChartMarker,
  OhlcvBar,
  StrategyConfig,
  StrategyRun,
  StrategyScore,
  Trade,
} from "./types";

export function runStrategies(
  bars: OhlcvBar[],
  configs: StrategyConfig[],
): StrategyRun[] {
  return configs
    .filter((config) => config.enabled)
    .map((config) => runImpulsePullbackLong(config, bars));
}

export function markersAtCursor(runs: StrategyRun[], cursor: number): ChartMarker[] {
  return runs.flatMap((run) =>
    run.markers.filter((marker) => marker.visibleFromIndex <= cursor),
  );
}

function scoreTrade(trade: Trade, bars: OhlcvBar[], cursor: number): StrategyScore {
  const empty: StrategyScore = {
    id: trade.strategyId,
    name: "",
    realizedR: 0,
    realizedPnl: 0,
    openR: 0,
    openPnl: 0,
    totalR: 0,
    totalPnl: 0,
    closedTrades: 0,
    openTrades: 0,
    wins: 0,
    losses: 0,
  };
  if (trade.entryIndex > cursor) return empty;

  const mark = (price: number) => {
    const points = price - trade.entryPrice;
    return {
      r: points / trade.riskPoints,
      pnl: points * trade.pointValue * trade.quantity,
    };
  };

  if (trade.exitIndex !== null && trade.exitPrice !== null && trade.exitIndex <= cursor) {
    const result = mark(trade.exitPrice);
    return {
      ...empty,
      realizedR: result.r,
      realizedPnl: result.pnl,
      totalR: result.r,
      totalPnl: result.pnl,
      closedTrades: 1,
      wins: trade.exitReason === "target" ? 1 : 0,
      losses: trade.exitReason === "stop" ? 1 : 0,
    };
  }

  const open = mark(bars[cursor].c);
  return {
    ...empty,
    openR: open.r,
    openPnl: open.pnl,
    totalR: open.r,
    totalPnl: open.pnl,
    openTrades: 1,
  };
}

function addScore(left: StrategyScore, right: StrategyScore): StrategyScore {
  return {
    id: left.id,
    name: left.name,
    realizedR: left.realizedR + right.realizedR,
    realizedPnl: left.realizedPnl + right.realizedPnl,
    openR: left.openR + right.openR,
    openPnl: left.openPnl + right.openPnl,
    totalR: left.totalR + right.totalR,
    totalPnl: left.totalPnl + right.totalPnl,
    closedTrades: left.closedTrades + right.closedTrades,
    openTrades: left.openTrades + right.openTrades,
    wins: left.wins + right.wins,
    losses: left.losses + right.losses,
  };
}

export function bookAtCursor(
  runs: StrategyRun[],
  bars: OhlcvBar[],
  cursor: number,
): BookSnapshot {
  const strategies = runs.map((run) => {
    const total = run.trades.reduce<StrategyScore>(
      (score, trade) => addScore(score, scoreTrade(trade, bars, cursor)),
      {
        id: run.config.id,
        name: run.config.name,
        realizedR: 0,
        realizedPnl: 0,
        openR: 0,
        openPnl: 0,
        totalR: 0,
        totalPnl: 0,
        closedTrades: 0,
        openTrades: 0,
        wins: 0,
        losses: 0,
      },
    );
    return total;
  });

  const combined = strategies.reduce<StrategyScore>(
    (score, item) => addScore(score, item),
    {
      id: "all",
      name: "All strategies",
      realizedR: 0,
      realizedPnl: 0,
      openR: 0,
      openPnl: 0,
      totalR: 0,
      totalPnl: 0,
      closedTrades: 0,
      openTrades: 0,
      wins: 0,
      losses: 0,
    },
  );

  return {
    strategies,
    realizedR: combined.realizedR,
    realizedPnl: combined.realizedPnl,
    openR: combined.openR,
    openPnl: combined.openPnl,
    totalR: combined.totalR,
    totalPnl: combined.totalPnl,
  };
}

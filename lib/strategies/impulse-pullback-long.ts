import type {
  ChartMarker,
  OhlcvBar,
  StrategyConfig,
  StrategyRun,
  Trade,
} from "./types";

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isImpulse(
  bars: OhlcvBar[],
  index: number,
  params: StrategyConfig["params"],
) {
  if (index < params.lookback) return false;
  const bar = bars[index];
  const range = bar.h - bar.l;
  const body = bar.c - bar.o;
  if (!(range > 0) || !(body > 0)) return false;
  if (body / range < params.minBodyRatio) return false;

  const prior = bars.slice(index - params.lookback, index);
  const avgBody = average(prior.map((item) => Math.abs(item.c - item.o)));
  const avgVolume = average(prior.map((item) => item.v));
  if (!(avgBody > 0) || !(avgVolume > 0)) return false;
  if (body < params.minBodyMultiple * avgBody) return false;
  if (bar.v < params.minVolumeMultiple * avgVolume) return false;
  return true;
}

function isPullback(
  bar: OhlcvBar,
  signal: OhlcvBar,
  averageVolume: number,
  params: StrategyConfig["params"],
) {
  if (!(bar.c < bar.o)) return false;
  const range = signal.h - signal.l;
  if (!(range > 0) || !(averageVolume > 0)) return false;
  const position = (bar.c - signal.l) / range;
  if (position < params.minClosePositionInSignalRange) return false;
  if (bar.c > signal.h || bar.c < signal.l) return false;
  if (bar.v > params.maxPullbackVolumeMultiple * averageVolume) return false;
  return true;
}

function limitTouched(bar: OhlcvBar, limit: number, stop: number) {
  if (bar.o <= stop) return false;
  return bar.l <= limit && bar.h >= limit;
}

function resolveLongExit(
  bar: OhlcvBar,
  stop: number,
  target: number,
): { price: number; reason: "stop" | "target" } | null {
  if (bar.o <= stop) return { price: bar.o, reason: "stop" };
  if (bar.o >= target) return { price: bar.o, reason: "target" };
  if (bar.l <= stop) return { price: stop, reason: "stop" };
  if (bar.h >= target) return { price: target, reason: "target" };
  return null;
}

export function runImpulsePullbackLong(
  config: StrategyConfig,
  bars: OhlcvBar[],
): StrategyRun {
  const { params } = config;
  const trades: Trade[] = [];
  const markers: ChartMarker[] = [];
  let index = params.lookback;

  while (index < bars.length) {
    if (!isImpulse(bars, index, params)) {
      index += 1;
      continue;
    }

    const signal = bars[index];
    const prior = bars.slice(index - params.lookback, index);
    const avgVolume = average(prior.map((bar) => bar.v));
    const pullbackEnd = Math.min(bars.length - 1, index + params.maxPullbackBars);
    let confirmIndex = -1;
    for (let cursor = index + 1; cursor <= pullbackEnd; cursor += 1) {
      if (isPullback(bars[cursor], signal, avgVolume, params)) {
        confirmIndex = cursor;
        break;
      }
    }
    if (confirmIndex < 0) {
      index += 1;
      continue;
    }

    const entryPrice = signal.c;
    const stopPrice = signal.l;
    const riskPoints = entryPrice - stopPrice;
    if (!(riskPoints > 0)) {
      index = confirmIndex + 1;
      continue;
    }
    const targetPrice = entryPrice + params.rewardMultiple * riskPoints;

    markers.push({
      strategyId: config.id,
      barIndex: index,
      visibleFromIndex: confirmIndex,
      kind: "signal",
      win: null,
    });

    let entryIndex = -1;
    const expiry = confirmIndex + params.limitExpiryBars;
    for (let cursor = confirmIndex + 1; cursor < bars.length && cursor <= expiry; cursor += 1) {
      if (limitTouched(bars[cursor], entryPrice, stopPrice)) {
        entryIndex = cursor;
        break;
      }
    }
    if (entryIndex < 0) {
      index = Math.min(bars.length, expiry + 1);
      continue;
    }

    markers.push({
      strategyId: config.id,
      barIndex: entryIndex,
      visibleFromIndex: entryIndex,
      kind: "entry",
      win: null,
    });

    let exitIndex: number | null = null;
    let exitPrice: number | null = null;
    let exitReason: Trade["exitReason"] = null;
    for (let cursor = entryIndex; cursor < bars.length; cursor += 1) {
      const exit = resolveLongExit(bars[cursor], stopPrice, targetPrice);
      if (!exit) continue;
      exitIndex = cursor;
      exitPrice = exit.price;
      exitReason = exit.reason;
      break;
    }

    if (exitIndex !== null && exitReason) {
      markers.push({
        strategyId: config.id,
        barIndex: exitIndex,
        visibleFromIndex: exitIndex,
        kind: "exit",
        win: exitReason === "target",
      });
    }

    trades.push({
      strategyId: config.id,
      signalIndex: index,
      confirmIndex,
      entryIndex,
      exitIndex,
      entryPrice,
      stopPrice,
      targetPrice,
      exitPrice,
      exitReason,
      riskPoints,
      pointValue: params.pointValue,
      quantity: params.quantity,
    });

    index = (exitIndex ?? entryIndex) + 1;
  }

  return { config, trades, markers };
}

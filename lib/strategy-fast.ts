import { fillSessionMasks } from "@/lib/chicago-session";
import { ema } from "@/lib/ema";
import type { OhlcvBar } from "@/lib/strategies/types";
import {
  isOppositeFlipLocked,
  noteStopFlipLock,
  resolveEntryLimitFill,
  resolveExitFill,
  type FlipLock,
  type ScriptMarker,
  type ScriptTrade,
} from "@/lib/strategy-script";

export type FastFilters = {
  bodyRatio: number;
  minBody: number;
  volLen: number;
  volMult: number;
};

export type FastLeg = {
  id: string;
  /** day = stacked-EMA hybrid (Paper default). eve = impulse + EMA→1R. */
  kind: "day" | "eve";
  side: "long" | "short";
  filters: FastFilters;
};

/** Stacked-EMA hybrid constants — match paper/ib_paper_loop.py + engine.mjs. */
export const HYBRID_EMA_FAST = 20;
export const HYBRID_EMA_MID = 50;
export const HYBRID_EMA_SLOW = 100;
export const HYBRID_LOOKBACK = 50;
export const HYBRID_REWARD_MULTIPLE = 3.5;
export const HYBRID_DOWN_HALF_AS_R = 2;
export const HYBRID_UP_HALF_AS_R = 2;
export const HYBRID_TICK = 0.25;

type OpenTrade = ScriptTrade;

type PendingEntry = {
  side: "long" | "short";
  stop: number;
  target: number;
  risk: number;
  limit: number;
  signalIndex: number;
  barsWaited: number;
};

type LegState = {
  spec: FastLeg;
  markers: ScriptMarker[];
  trades: ScriptTrade[];
  open: OpenTrade | null;
  pending: PendingEntry | null;
  /** Eve only: EMA→1R price scheduled on a prior bar. */
  pendingTightenTarget: number | null;
  volSum: number;
};

function ema5Series(closes: Float64Array): Float64Array {
  const out = new Float64Array(closes.length);
  const period = 5;
  if (closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += closes[i];
  let previous = sum / period;
  out[period - 1] = previous;
  const weight = 2 / (period + 1);
  const keep = 1 - weight;
  for (let i = period; i < closes.length; i += 1) {
    previous = closes[i] * weight + previous * keep;
    out[i] = previous;
  }
  return out;
}

function toFloatEma(series: (number | null)[]): Float64Array {
  const out = new Float64Array(series.length);
  for (let i = 0; i < series.length; i += 1) {
    const v = series[i];
    out[i] = v == null ? 0 : v;
  }
  return out;
}

export function lookbackHighInclusive(bars: OhlcvBar[], i: number, n: number): number {
  const start = Math.max(0, i - n + 1);
  let hi = -Infinity;
  for (let j = start; j <= i; j += 1) if (bars[j].h > hi) hi = bars[j].h;
  return hi;
}

export function lookbackLowInclusive(bars: OhlcvBar[], i: number, n: number): number {
  const start = Math.max(0, i - n + 1);
  let lo = Infinity;
  for (let j = start; j <= i; j += 1) if (bars[j].l < lo) lo = bars[j].l;
  return lo;
}

/**
 * Stacked-EMA hybrid signal sizing (no look-ahead beyond signal bar).
 * Long: EMA20>50>100 + vol; short: EMA20<50<100 + vol.
 * Long down-bar: halfDist=(H50−C)/2 as hybridDownHalfAsR R-units.
 * Short up-bar: halfDist=(C−L50)/2 as hybridUpHalfAsR R-units.
 * With-trend / doji: TP at 50H/50L, R = |TP−C| / rewardMultiple.
 */
export function hybridSignalOf(
  side: "long" | "short",
  bar: OhlcvBar,
  bars: OhlcvBar[],
  i: number,
  sessionOk: boolean,
  avgVol: number,
  volMult: number,
  emaF: number,
  emaM: number,
  emaS: number,
): { stop: number; target: number; risk: number } | null {
  if (!sessionOk) return null;
  if (!(emaF > 0 && emaM > 0 && emaS > 0)) return null;
  if (!(avgVol > 0 && bar.v >= avgVol * volMult)) return null;

  const entry = bar.c;
  if (side === "long") {
    if (!(emaF > emaM && emaM > emaS)) return null;
    const h50 = lookbackHighInclusive(bars, i, HYBRID_LOOKBACK);
    if (!(h50 > entry)) return null;
    if (bar.c < bar.o && HYBRID_DOWN_HALF_AS_R > 0) {
      const halfDist = (h50 - entry) / 2;
      if (!(halfDist >= HYBRID_TICK)) return null;
      const risk = halfDist / HYBRID_DOWN_HALF_AS_R;
      if (!(risk >= HYBRID_TICK)) return null;
      return { target: entry + halfDist, risk, stop: entry - risk };
    }
    const target = h50;
    const risk = (target - entry) / HYBRID_REWARD_MULTIPLE;
    if (!(risk >= HYBRID_TICK)) return null;
    return { target, risk, stop: entry - risk };
  }

  if (!(emaF < emaM && emaM < emaS)) return null;
  const l50 = lookbackLowInclusive(bars, i, HYBRID_LOOKBACK);
  if (!(l50 < entry)) return null;
  if (bar.c > bar.o && HYBRID_UP_HALF_AS_R > 0) {
    const halfDist = (entry - l50) / 2;
    if (!(halfDist >= HYBRID_TICK)) return null;
    const risk = halfDist / HYBRID_UP_HALF_AS_R;
    if (!(risk >= HYBRID_TICK)) return null;
    return { target: entry - halfDist, risk, stop: entry + risk };
  }
  const target = l50;
  const risk = (entry - target) / HYBRID_REWARD_MULTIPLE;
  if (!(risk >= HYBRID_TICK)) return null;
  return { target, risk, stop: entry + risk };
}

function eveSignalOf(
  spec: FastLeg,
  bar: OhlcvBar,
  sessionOk: boolean,
  avgVol: number,
): { stop: number; target: number; risk: number } | null {
  if (!sessionOk) return null;
  const body = Math.abs(bar.c - bar.o);
  const span = Math.max(bar.h - bar.l, 0.25);
  const impulse = spec.side === "long" ? bar.c > bar.o : bar.c < bar.o;
  if (
    !(
      impulse &&
      body / span >= spec.filters.bodyRatio &&
      body >= spec.filters.minBody &&
      bar.v > avgVol * spec.filters.volMult
    )
  ) {
    return null;
  }
  const risk1 = spec.side === "long" ? Math.max(bar.c - bar.l, 1) : Math.max(bar.h - bar.c, 1);
  const stop = spec.side === "long" ? bar.c - risk1 * 2 : bar.c + risk1 * 2;
  const target = spec.side === "long" ? bar.c + risk1 * 2.5 : bar.c - risk1 * 2.5;
  return { stop, target, risk: risk1 };
}

/** Eve only: EMA adverse at close → exit@close (matches eve builder `{ exit: true }`). Hybrid: never. */
function eveEmaExitClose(spec: FastLeg, bar: OhlcvBar, pos: OpenTrade, emaValue: number): boolean {
  if (spec.kind !== "eve") return false;
  if (pos.side !== spec.side) return false;
  return spec.side === "long" ? bar.c < emaValue : bar.c > emaValue;
}

/** Cancel pending if stop is touched before the limit fills (Paper / engine.mjs). */
function pendingCancelledByStop(
  bar: OhlcvBar,
  side: "long" | "short",
  stop: number,
): boolean {
  if (side === "long") return bar.o <= stop || bar.l <= stop;
  return bar.o >= stop || bar.h >= stop;
}

/**
 * Same fills, flip lock, and 2-bar entry expiry as `runLinkedStrategyScripts`
 * for scripts produced by the daytime (stacked-EMA hybrid) and eve builders.
 */
export function runGeneratedLegs(
  bars: OhlcvBar[],
  specs: FastLeg[],
  options: { entryLimitExpiryBars: number; flipLockBars: number },
): { ok: true; runs: { id: string; run: { ok: true; markers: ScriptMarker[]; trades: ScriptTrade[] } }[] } {
  const expiryBars = options.entryLimitExpiryBars;
  const instantFill = expiryBars <= 0;
  const flipLockBars = options.flipLockBars;
  const n = bars.length;
  const closes = new Float64Array(n);
  const tsMs = new Float64Array(n);
  const closeArr: number[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    closes[i] = bars[i].c;
    closeArr[i] = bars[i].c;
    tsMs[i] = bars[i].ts;
  }
  const needsEve = specs.some((s) => s.kind === "eve");
  const needsHybrid = specs.some((s) => s.kind === "day");
  const ema5 = needsEve ? ema5Series(closes) : new Float64Array(n);
  const emaF = needsHybrid ? toFloatEma(ema(closeArr, HYBRID_EMA_FAST)) : new Float64Array(n);
  const emaM = needsHybrid ? toFloatEma(ema(closeArr, HYBRID_EMA_MID)) : new Float64Array(n);
  const emaS = needsHybrid ? toFloatEma(ema(closeArr, HYBRID_EMA_SLOW)) : new Float64Array(n);
  const dayMask = new Uint8Array(n);
  const eveMask = new Uint8Array(n);
  fillSessionMasks(tsMs, dayMask, eveMask);

  const legs: LegState[] = specs.map((spec) => ({
    spec,
    markers: [],
    trades: [],
    open: null,
    pending: null,
    pendingTightenTarget: null,
    volSum: 0,
  }));
  const locks: FlipLock[] = [];
  const hybridReady = Math.max(HYBRID_EMA_SLOW, HYBRID_LOOKBACK) + 1;

  const pushExit = (
    leg: LegState,
    pos: OpenTrade,
    i: number,
    exit: { price: number; reason: "stop" | "target" | "session_end" },
  ) => {
    pos.exitIndex = i;
    pos.exitReason = exit.reason === "session_end" ? "stop" : exit.reason;
    // session_end: mark as stop for win-rate (not a target win); PnL still at close.
    pos.exitPrice = exit.price;
    leg.markers.push({
      strategyId: leg.spec.id,
      barIndex: i,
      visibleFromIndex: i,
      kind: "exit",
      win: exit.reason === "target",
      price: exit.price,
      side: pos.side,
    });
    leg.trades.push(pos);
    if (exit.reason === "stop") {
      noteStopFlipLock(locks, flipLockBars, i, pos.side, "stop");
    }
  };

  const makeOpen = (
    leg: LegState,
    i: number,
    fillPrice: number,
    from: { side: "long" | "short"; stop: number; target: number; risk: number; signalIndex: number },
  ): OpenTrade => {
    leg.markers.push({
      strategyId: leg.spec.id,
      barIndex: i,
      visibleFromIndex: i,
      kind: "entry",
      win: null,
      price: fillPrice,
      side: from.side,
    });
    return {
      strategyId: leg.spec.id,
      side: from.side,
      signalIndex: from.signalIndex,
      entryIndex: i,
      exitIndex: null,
      entryPrice: fillPrice,
      stopPrice: from.stop,
      targetPrice: from.target,
      exitPrice: null,
      exitReason: null,
      riskPoints: from.risk,
    };
  };

  /** Paper both-mode: one hybrid pending/open across long+short legs. */
  const hybridBusy = (): boolean =>
    legs.some((leg) => leg.spec.kind === "day" && (leg.open !== null || leg.pending !== null));

  for (let i = 0; i < n; i += 1) {
    const bar = bars[i];
    const emaValue = i >= 4 ? ema5[i] : 0;

    for (const leg of legs) {
      const volLen = leg.spec.filters.volLen;
      leg.volSum += bar.v;
      if (i >= volLen) leg.volSum -= bars[i - volLen].v;
      const volCount = i + 1 < volLen ? i + 1 : volLen;
      const avgVol = volCount === 0 ? 0 : leg.volSum / volCount;
      const sessionOk = (leg.spec.kind === "eve" ? eveMask[i] : dayMask[i]) === 1;

      if (leg.open !== null) {
        const pos = leg.open;
        // Hybrid / daytime: flatten when outside day session (gap avoidance).
        if (leg.spec.kind === "day" && !sessionOk) {
          pushExit(leg, pos, i, { price: bar.c, reason: "session_end" });
          leg.open = null;
          leg.pendingTightenTarget = null;
          continue;
        }
        if (leg.pendingTightenTarget !== null) {
          pos.targetPrice = leg.pendingTightenTarget;
          leg.pendingTightenTarget = null;
        }
        const exit = resolveExitFill(bar, pos.side, pos.stopPrice, pos.targetPrice);
        if (exit) {
          pushExit(leg, pos, i, exit);
          leg.open = null;
          leg.pendingTightenTarget = null;
          continue;
        }
        if (eveEmaExitClose(leg.spec, bar, pos, emaValue)) {
          pushExit(leg, pos, i, { price: bar.c, reason: "target" });
          leg.open = null;
          leg.pendingTightenTarget = null;
        }
        continue;
      }

      if (leg.pending !== null) {
        const pending = leg.pending;
        if (leg.spec.kind === "day" && !sessionOk) {
          leg.pending = null;
          continue;
        }
        if (leg.spec.kind === "day" && pendingCancelledByStop(bar, pending.side, pending.stop)) {
          leg.pending = null;
          continue;
        }
        const fill = resolveEntryLimitFill(bar, pending.side, pending.limit, pending.stop);
        if (fill !== null) {
          const pos = makeOpen(leg, i, fill, pending);
          leg.pending = null;
          if (leg.spec.kind === "day" && !sessionOk) {
            pushExit(leg, pos, i, { price: bar.c, reason: "session_end" });
            continue;
          }
          const exit = resolveExitFill(bar, pos.side, pos.stopPrice, pos.targetPrice);
          if (exit) {
            pushExit(leg, pos, i, exit);
            continue;
          }
          if (eveEmaExitClose(leg.spec, bar, pos, emaValue)) {
            pushExit(leg, pos, i, { price: bar.c, reason: "target" });
            continue;
          }
          leg.open = pos;
          continue;
        }
        pending.barsWaited += 1;
        if (pending.barsWaited >= expiryBars) leg.pending = null;
        continue;
      }

      if (leg.spec.kind === "day") {
        if (!sessionOk || i + 1 < hybridReady) continue;
        if (hybridBusy()) continue;
        const signal = hybridSignalOf(
          leg.spec.side,
          bar,
          bars,
          i,
          sessionOk,
          avgVol,
          leg.spec.filters.volMult,
          emaF[i],
          emaM[i],
          emaS[i],
        );
        if (!signal) continue;
        if (isOppositeFlipLocked(locks, leg.spec.side, i)) continue;
        const limit = bar.c;
        leg.markers.push({
          strategyId: leg.spec.id,
          barIndex: i,
          visibleFromIndex: i,
          kind: "signal",
          win: null,
          price: null,
          side: leg.spec.side,
        });
        if (instantFill) {
          leg.open = makeOpen(leg, i, limit, {
            side: leg.spec.side,
            stop: signal.stop,
            target: signal.target,
            risk: signal.risk,
            signalIndex: i,
          });
          continue;
        }
        leg.pending = {
          side: leg.spec.side,
          stop: signal.stop,
          target: signal.target,
          risk: signal.risk,
          limit,
          signalIndex: i,
          barsWaited: 0,
        };
        continue;
      }

      // Eve impulse path
      const signal = eveSignalOf(leg.spec, bar, sessionOk, avgVol);
      if (!signal) continue;
      if (isOppositeFlipLocked(locks, leg.spec.side, i)) continue;
      const limit = bar.c;
      leg.markers.push({
        strategyId: leg.spec.id,
        barIndex: i,
        visibleFromIndex: i,
        kind: "signal",
        win: null,
        price: null,
        side: leg.spec.side,
      });
      if (instantFill) {
        leg.open = makeOpen(leg, i, limit, {
          side: leg.spec.side,
          stop: signal.stop,
          target: signal.target,
          risk: signal.risk,
          signalIndex: i,
        });
        continue;
      }
      leg.pending = {
        side: leg.spec.side,
        stop: signal.stop,
        target: signal.target,
        risk: signal.risk,
        limit,
        signalIndex: i,
        barsWaited: 0,
      };
    }
  }

  for (const leg of legs) {
    if (leg.open) leg.trades.push(leg.open);
  }

  return {
    ok: true,
    runs: legs.map((leg) => ({
      id: leg.spec.id,
      run: { ok: true as const, markers: leg.markers, trades: leg.trades },
    })),
  };
}

import { fillSessionMasks } from "@/lib/chicago-session";
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
  kind: "day" | "eve";
  side: "long" | "short";
  filters: FastFilters;
};

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
  /** EMA→1R price scheduled on a prior bar; applied at the start of this bar. */
  pendingTightenTarget: number | null;
  volSum: number;
};

function ema5(closes: Float64Array): Float64Array {
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

function signalOf(
  spec: FastLeg,
  bar: OhlcvBar,
  sessionOk: boolean,
  avgVol: number,
): { stop: number; target: number; risk: number | null } | null {
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
  if (spec.kind === "eve") {
    const risk1 = spec.side === "long" ? Math.max(bar.c - bar.l, 1) : Math.max(bar.h - bar.c, 1);
    const stop = spec.side === "long" ? bar.c - risk1 * 2 : bar.c + risk1 * 2;
    const target = spec.side === "long" ? bar.c + risk1 * 2.5 : bar.c - risk1 * 2.5;
    return { stop, target, risk: risk1 };
  }
  const risk = spec.side === "long" ? Math.max(bar.c - bar.l, 1) : Math.max(bar.h - bar.c, 1);
  const stop = spec.side === "long" ? bar.l : bar.h;
  const target = spec.side === "long" ? bar.c + risk * 2.5 : bar.c - risk * 2.5;
  return { stop, target, risk: null };
}

/**
 * Boss live EMA manage (honest):
 * - adverse EMA at close AND already ≥1R at close → exit@close
 * - adverse EMA otherwise → schedule 1R TP for next bar (no signal-bar OHLC 1R fill)
 */
type EmaManage =
  | { kind: "exitClose" }
  | { kind: "schedule1R"; price: number }
  | null;

function emaManageAction(spec: FastLeg, bar: OhlcvBar, pos: OpenTrade, emaValue: number): EmaManage {
  if (pos.side !== spec.side) return null;
  const crossed = spec.side === "long" ? bar.c < emaValue : bar.c > emaValue;
  if (!crossed) return null;
  const oneR =
    spec.side === "long" ? pos.entryPrice + pos.riskPoints : pos.entryPrice - pos.riskPoints;
  const already1R = spec.side === "long" ? bar.c >= oneR : bar.c <= oneR;
  if (already1R) return { kind: "exitClose" };
  return { kind: "schedule1R", price: oneR };
}

/**
 * Same fills, flip lock, and 2-bar entry expiry as `runLinkedStrategyScripts`
 * for scripts produced by the daytime and eve builders. Returns null when a
 * caller should use the interpreter instead — this module only runs legs
 * the caller has already classified.
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
  for (let i = 0; i < n; i += 1) {
    closes[i] = bars[i].c;
    tsMs[i] = bars[i].ts;
  }
  const ema = ema5(closes);
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

  const pushExit = (
    leg: LegState,
    pos: OpenTrade,
    i: number,
    exit: { price: number; reason: "stop" | "target" },
  ) => {
    pos.exitIndex = i;
    pos.exitReason = exit.reason;
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
    noteStopFlipLock(locks, flipLockBars, i, pos.side, exit.reason);
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

  for (let i = 0; i < n; i += 1) {
    const bar = bars[i];
    const emaValue = i >= 4 ? ema[i] : 0;
    for (const leg of legs) {
      const volLen = leg.spec.filters.volLen;
      leg.volSum += bar.v;
      if (i >= volLen) leg.volSum -= bars[i - volLen].v;
      const volCount = i + 1 < volLen ? i + 1 : volLen;
      const avgVol = volCount === 0 ? 0 : leg.volSum / volCount;
      const sessionOk = (leg.spec.kind === "eve" ? eveMask[i] : dayMask[i]) === 1;

      if (leg.open !== null) {
        const pos = leg.open;
        // Legacy scheduled 1R tighten (if any) before exits.
        if (leg.pendingTightenTarget !== null) {
          pos.targetPrice = leg.pendingTightenTarget;
          leg.pendingTightenTarget = null;
        }
        // Stop / far TP first.
        const exit = resolveExitFill(bar, pos.side, pos.stopPrice, pos.targetPrice);
        if (exit) {
          pushExit(leg, pos, i, exit);
          leg.open = null;
          leg.pendingTightenTarget = null;
          continue;
        }
        // Honest EMA→1R: ≥1R at close → exit@close; else schedule 1R next bar.
        const emaAct = emaManageAction(leg.spec, bar, pos, emaValue);
        if (emaAct?.kind === "exitClose") {
          pushExit(leg, pos, i, { price: bar.c, reason: "target" });
          leg.open = null;
          leg.pendingTightenTarget = null;
        } else if (emaAct?.kind === "schedule1R") {
          leg.pendingTightenTarget = emaAct.price;
        }
        continue;
      }

      if (leg.pending !== null) {
        const pending = leg.pending;
        const fill = resolveEntryLimitFill(bar, pending.side, pending.limit, pending.stop);
        if (fill !== null) {
          const pos = makeOpen(leg, i, fill, pending);
          leg.pending = null;
          const exit = resolveExitFill(bar, pos.side, pos.stopPrice, pos.targetPrice);
          if (exit) {
            pushExit(leg, pos, i, exit);
            continue;
          }
          // Fill bar: same honest EMA→1R rule as open-leg path.
          const emaAct = emaManageAction(leg.spec, bar, pos, emaValue);
          if (emaAct?.kind === "exitClose") {
            pushExit(leg, pos, i, { price: bar.c, reason: "target" });
            continue;
          }
          if (emaAct?.kind === "schedule1R") {
            leg.pendingTightenTarget = emaAct.price;
          }
          leg.open = pos;
          continue;
        }
        pending.barsWaited += 1;
        if (pending.barsWaited >= expiryBars) leg.pending = null;
        continue;
      }

      const signal = signalOf(leg.spec, bar, sessionOk, avgVol);
      if (!signal) continue;
      if (isOppositeFlipLocked(locks, leg.spec.side, i)) continue;
      const limit = bar.c;
      const stopDistance = Math.max(Math.abs(limit - signal.stop), 0.25);
      const risk = signal.risk !== null && signal.risk > 0 ? signal.risk : stopDistance;
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
          risk,
          signalIndex: i,
        });
        continue;
      }
      leg.pending = {
        side: leg.spec.side,
        stop: signal.stop,
        target: signal.target,
        risk,
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

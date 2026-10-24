import { ema } from "@/lib/ema";
import type { OhlcvBar } from "@/lib/strategies/types";

export const STRATEGY_STORAGE_KEY = "mnq-replay.strategyScript";
export const ENTRY_FILTERS_STORAGE_KEY = "mnq-replay.entryFilters";
export const ROUND_TRIP_FEE_STORAGE_KEY = "mnq-replay.roundTripFeeUsd";

/** USD charged once when a trade closes (full round-trip). */
export const DEFAULT_ROUND_TRIP_FEE_USD = 1.6;

export function normalizeRoundTripFee(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_ROUND_TRIP_FEE_USD;
  return n;
}

export type EntryFilters = {
  /** Min body / range ratio, e.g. 0.45 */
  bodyRatio: number;
  /** Min absolute body in index points, e.g. 2 */
  minBody: number;
  /** Volume SMA length, e.g. 15 */
  volLen: number;
  /** Volume must exceed SMA × this, e.g. 1.2 */
  volMult: number;
};

export const DEFAULT_ENTRY_FILTERS: EntryFilters = {
  bodyRatio: 0.45,
  minBody: 2,
  volLen: 15,
  volMult: 1.2,
};

function clampFilters(raw: Partial<EntryFilters> | null | undefined): EntryFilters {
  const base = DEFAULT_ENTRY_FILTERS;
  const num = (value: unknown, fallback: number) => {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const bodyRatio = Math.min(1, Math.max(0.05, num(raw?.bodyRatio, base.bodyRatio)));
  const minBody = Math.min(200, Math.max(0.25, num(raw?.minBody, base.minBody)));
  const volLen = Math.min(200, Math.max(2, Math.round(num(raw?.volLen, base.volLen))));
  const volMult = Math.min(20, Math.max(0.1, num(raw?.volMult, base.volMult)));
  return { bodyRatio, minBody, volLen, volMult };
}

export function normalizeEntryFilters(raw: Partial<EntryFilters> | null | undefined): EntryFilters {
  return clampFilters(raw);
}

/** Previous on-page defaults. A saved copy of either one upgrades to the current script. */
export const LEGACY_DEFAULT_STRATEGY_SCRIPT = `// MNQ 1-minute strategy. This runs in the browser on each bar.
// bar: { ts, o, h, l, c, v }
// ta.sma(i, length, "o" | "h" | "l" | "c" | "v")
// Return { signal: true, side: "long" | "short", stop, target } or null.
// Entry fills at the signal close. One position at a time.

const avgVol = ta.sma(i, 20, "v")
const body = Math.abs(bar.c - bar.o)
const span = Math.max(bar.h - bar.l, 0.25)
if (bar.c > bar.o && body / span >= 0.55 && body >= 4 && bar.v > avgVol * 1.8) {
  const risk = Math.max(bar.c - bar.l, 1)
  return { signal: true, side: "long", stop: bar.l, target: bar.c + risk * 2 }
}
return null
`;

export const EMA_EXIT_DEFAULT_STRATEGY_SCRIPT = `// MNQ 1-minute strategy. This runs in the browser on each bar.
// bar: { ts, o, h, l, c, v }
// ta.sma / ta.ema(i, length, "o" | "h" | "l" | "c" | "v")
// position: null, or { side, entry, stop, target, risk } while a trade is open
// Return { signal: true, side, stop, target } to enter, { target } to tighten, or null.
// Entry fills at the signal close. One position at a time.
// Impulse entries still target 2R. A close below the 5 EMA tightens that to 1R.

const ema5 = ta.ema(i, 5, "c")
if (position && position.side === "long" && bar.c < ema5) {
  return { target: position.entry + position.risk }
}

const avgVol = ta.sma(i, 20, "v")
const body = Math.abs(bar.c - bar.o)
const span = Math.max(bar.h - bar.l, 0.25)
if (!position && bar.c > bar.o && body / span >= 0.55 && body >= 4 && bar.v > avgVol * 1.8) {
  const risk = Math.max(bar.c - bar.l, 1)
  return { signal: true, side: "long", stop: bar.l, target: bar.c + risk * 2 }
}
return null
`;

export function buildLongStrategyScript(filters: EntryFilters = DEFAULT_ENTRY_FILTERS): string {
  const f = clampFilters(filters);
  return `// MNQ 1-minute strategy. This runs in the browser on each bar.
// bar: { ts, o, h, l, c, v }
// ta.sma / ta.ema(i, length, "o" | "h" | "l" | "c" | "v")
// position: null, or { side, entry, stop, target, risk } while a trade is open
// Return { signal: true, side, stop, target } to enter, { target } to tighten, or null.
// Entry is a limit at the signal close; expires after 2 completed 1m bars if unfilled. One position at a time.
// Impulse entries still target 2.5R. A close below the 5 EMA tightens that to 1R.
// New longs only America/Chicago 09:00–20:29 (session close 21:00; no new entries last 30 min); Fri no new entries from 14:45 CT. Open trades still manage/exit.
// Filters: body/range >= ${f.bodyRatio}, body >= ${f.minBody}, vol > SMA(${f.volLen}) * ${f.volMult}

const ema5 = ta.ema(i, 5, "c")
if (position && position.side === "long" && bar.c < ema5) {
  return { target: position.entry + position.risk }
}

// SESSION_START=09:00 CT, SESSION_END=21:00 CT, ENTRY_CUTOFF_MINUTES_BEFORE_CLOSE=30 → last new entry before 20:30 CT; FRIDAY_ENTRY_CUTOFF=14:45 CT (no new entries Fri >= 14:45)
const ctParts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Chicago", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(bar.ts))
const ctMins = Number(ctParts.find((p) => p.type === "hour")?.value ?? 0) * 60 + Number(ctParts.find((p) => p.type === "minute")?.value ?? 0)
const ctWd = ctParts.find((p) => p.type === "weekday")?.value ?? ""
const sessionOk = ctMins >= 9 * 60 && ctMins < 21 * 60 - 30 && !(ctWd === "Fri" && ctMins >= 14 * 60 + 45)
const avgVol = ta.sma(i, ${f.volLen}, "v")
const body = Math.abs(bar.c - bar.o)
const span = Math.max(bar.h - bar.l, 0.25)
if (!position && sessionOk && bar.c > bar.o && body / span >= ${f.bodyRatio} && body >= ${f.minBody} && bar.v > avgVol * ${f.volMult}) {
  const risk = Math.max(bar.c - bar.l, 1)
  return { signal: true, side: "long", stop: bar.l, target: bar.c + risk * 2.5 }
}
return null
`;
}

export function buildShortStrategyScript(filters: EntryFilters = DEFAULT_ENTRY_FILTERS): string {
  const f = clampFilters(filters);
  return `// MNQ 1-minute strategy. This runs in the browser on each bar.
// Inverse of the default long impulse: short a bearish impulse.
// bar: { ts, o, h, l, c, v }
// ta.sma / ta.ema(i, length, "o" | "h" | "l" | "c" | "v")
// position: null, or { side, entry, stop, target, risk } while a trade is open
// Return { signal: true, side, stop, target } to enter, { target } to tighten, or null.
// Entry is a limit at the signal close; expires after 2 completed 1m bars if unfilled. One position at a time.
// Impulse entries still target 2.5R. A close above the 5 EMA tightens that to 1R.
// New shorts only America/Chicago 09:00–20:29 (session close 21:00; no new entries last 30 min); Fri no new entries from 14:45 CT. Open trades still manage/exit.
// Filters: body/range >= ${f.bodyRatio}, body >= ${f.minBody}, vol > SMA(${f.volLen}) * ${f.volMult}

const ema5 = ta.ema(i, 5, "c")
if (position && position.side === "short" && bar.c > ema5) {
  return { target: position.entry - position.risk }
}

// SESSION_START=09:00 CT, SESSION_END=21:00 CT, ENTRY_CUTOFF_MINUTES_BEFORE_CLOSE=30 → last new entry before 20:30 CT; FRIDAY_ENTRY_CUTOFF=14:45 CT (no new entries Fri >= 14:45)
const ctParts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Chicago", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(bar.ts))
const ctMins = Number(ctParts.find((p) => p.type === "hour")?.value ?? 0) * 60 + Number(ctParts.find((p) => p.type === "minute")?.value ?? 0)
const ctWd = ctParts.find((p) => p.type === "weekday")?.value ?? ""
const sessionOk = ctMins >= 9 * 60 && ctMins < 21 * 60 - 30 && !(ctWd === "Fri" && ctMins >= 14 * 60 + 45)
const avgVol = ta.sma(i, ${f.volLen}, "v")
const body = Math.abs(bar.c - bar.o)
const span = Math.max(bar.h - bar.l, 0.25)
if (!position && sessionOk && bar.c < bar.o && body / span >= ${f.bodyRatio} && body >= ${f.minBody} && bar.v > avgVol * ${f.volMult}) {
  const risk = Math.max(bar.h - bar.c, 1)
  return { signal: true, side: "short", stop: bar.h, target: bar.c - risk * 2.5 }
}
return null
`;
}

export const DEFAULT_STRATEGY_SCRIPT = buildLongStrategyScript(DEFAULT_ENTRY_FILTERS);
export const DEFAULT_SHORT_STRATEGY_SCRIPT = buildShortStrategyScript(DEFAULT_ENTRY_FILTERS);

export function isStaleDefaultScript(script: string) {
  if (script === LEGACY_DEFAULT_STRATEGY_SCRIPT || script === EMA_EXIT_DEFAULT_STRATEGY_SCRIPT) {
    return true;
  }
  // Pre-2.5R defaults (including prior session cutoffs): still say target 2R.
  if (script.includes("Impulse entries still target 2R")) {
    return true;
  }
  // Pre-pending-limit: instant fill at signal close (paper now expires unfilled after 2 bars).
  if (script.includes("Entry fills at the signal close")) {
    return true;
  }
  // Pre-cutoff defaults used hour-only Chicago 09–21; upgrade to 09:00–20:29 entry window.
  if (script.includes("const sessionOk = ct >= 9 && ct <= 21")) {
    return true;
  }
  // Pre-Friday cutoff: had 09:00–20:29 window but no Fri 14:45 CT block.
  return (
    script.includes("ctMins >= 9 * 60 && ctMins < 21 * 60 - 30") &&
    !script.includes("FRIDAY_ENTRY_CUTOFF")
  );
}

export type ScriptMarker = {
  strategyId: string;
  barIndex: number;
  visibleFromIndex: number;
  kind: "signal" | "entry" | "exit";
  win: boolean | null;
  price: number | null;
  side: "long" | "short" | null;
};

export type ScriptTrade = {
  strategyId: string;
  side: "long" | "short";
  signalIndex: number;
  entryIndex: number;
  exitIndex: number | null;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  exitPrice: number | null;
  exitReason: "stop" | "target" | null;
  riskPoints: number;
};

export type ScriptScore = {
  /** Net index points (price move), not R-multiples. */
  totalPoints: number;
  totalPnl: number;
  realizedPoints: number;
  openPoints: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
};

export type ScriptRun =
  | { ok: true; markers: ScriptMarker[]; trades: ScriptTrade[] }
  | { ok: false; error: string; markers: ScriptMarker[]; trades: ScriptTrade[] };

type Field = "o" | "h" | "l" | "c" | "v";

type PositionView = {
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  risk: number;
};

type BarFn = (
  bar: OhlcvBar,
  i: number,
  bars: OhlcvBar[],
  ta: {
    sma: (index: number, length: number, field: Field) => number;
    ema: (index: number, length: number, field: Field) => number;
  },
  position: PositionView | null,
) => unknown;

function isField(value: unknown): value is Field {
  return value === "o" || value === "h" || value === "l" || value === "c" || value === "v";
}

function isBarFn(value: unknown): value is BarFn {
  return typeof value === "function";
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readTarget(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const record = Object.fromEntries(Object.entries(value));
  if (record.signal === true) return null;
  return readNumber(record, "target");
}

function readSignal(value: unknown): {
  side: "long" | "short";
  stop: number;
  target: number;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const record = Object.fromEntries(Object.entries(value));
  if (record.signal !== true) return null;
  const side = record.side === "short" ? "short" : "long";
  const stop = readNumber(record, "stop");
  const target = readNumber(record, "target");
  if (stop === null || target === null) return null;
  return { side, stop, target };
}


/** Completed 1m bars after the signal bar an unfilled entry limit may wait (matches paper). */
export const ENTRY_LIMIT_EXPIRY_BARS = 2;

/**
 * Pending entry limit fill (paper Limit @ signal close).
 * Long buy-limit: fill if traded at/through limit without already opening through stop.
 * Short sell-limit: mirror.
 * Returns fill price or null.
 */
function resolveEntryLimitFill(
  bar: OhlcvBar,
  side: "long" | "short",
  limit: number,
  stop: number,
): number | null {
  if (side === "long") {
    if (bar.o <= stop) return null;
    if (bar.o <= limit) return bar.o;
    if (bar.l <= limit) return limit;
    return null;
  }
  if (bar.o >= stop) return null;
  if (bar.o >= limit) return bar.o;
  if (bar.h >= limit) return limit;
  return null;
}

/** Realistic OHLC fill: gap-through at open, else level if touched. Prefer stop if both. */
function resolveExitFill(
  bar: OhlcvBar,
  side: "long" | "short",
  stop: number,
  target: number,
): { price: number; reason: "stop" | "target" } | null {
  if (side === "long") {
    if (bar.o <= stop) return { price: bar.o, reason: "stop" };
    if (bar.o >= target) return { price: bar.o, reason: "target" };
    if (bar.l <= stop) return { price: stop, reason: "stop" };
    if (bar.h >= target) return { price: target, reason: "target" };
    return null;
  }
  if (bar.o >= stop) return { price: bar.o, reason: "stop" };
  if (bar.o <= target) return { price: bar.o, reason: "target" };
  if (bar.h >= stop) return { price: stop, reason: "stop" };
  if (bar.l <= target) return { price: target, reason: "target" };
  return null;
}

function compile(source: string): BarFn {
  const created: unknown = new Function(
    "bar",
    "i",
    "bars",
    "ta",
    "position",
    `"use strict";\n${source}`,
  );
  if (!isBarFn(created)) {
    throw new Error("Script did not compile.");
  }
  return created;
}

export type RunStrategyOptions = {
  /**
   * Bars after the signal an unfilled entry limit may wait.
   * `<= 0` = legacy instant fill at signal close.
   * Default `ENTRY_LIMIT_EXPIRY_BARS` (2) matches paper.
   */
  entryLimitExpiryBars?: number;
};

export function runStrategyScript(
  bars: OhlcvBar[],
  source: string,
  strategyId = "script",
  options: RunStrategyOptions = {},
): ScriptRun {
  const expiryBars =
    options.entryLimitExpiryBars === undefined
      ? ENTRY_LIMIT_EXPIRY_BARS
      : options.entryLimitExpiryBars;
  const instantFill = expiryBars <= 0;

  let fn: BarFn;
  try {
    fn = compile(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Script failed to compile.";
    return { ok: false, error: message, markers: [], trades: [] };
  }

  const emaCache = new Map<string, (number | null)[]>();
  const ta = {
    sma(index: number, length: number, field: Field) {
      if (!isField(field) || length < 1) return 0;
      const start = Math.max(0, index - Math.floor(length) + 1);
      let sum = 0;
      let count = 0;
      for (let cursor = start; cursor <= index; cursor += 1) {
        sum += bars[cursor][field];
        count += 1;
      }
      return count === 0 ? 0 : sum / count;
    },
    ema(index: number, length: number, field: Field) {
      if (!isField(field) || length < 1) return 0;
      const period = Math.floor(length);
      const key = `${field}:${period}`;
      let series = emaCache.get(key);
      if (!series) {
        series = ema(
          bars.map((bar) => bar[field]),
          period,
        );
        emaCache.set(key, series);
      }
      return series[index] ?? 0;
    },
  };

  const markers: ScriptMarker[] = [];
  const trades: ScriptTrade[] = [];
  let open: ScriptTrade | null = null;
  type PendingEntry = {
    side: "long" | "short";
    stop: number;
    target: number;
    risk: number;
    limit: number;
    signalIndex: number;
    barsWaited: number;
  };
  let pending: PendingEntry | null = null;

  const makeOpen = (
    i: number,
    fillPrice: number,
    from: { side: "long" | "short"; stop: number; target: number; risk: number; signalIndex: number },
  ): ScriptTrade => {
    markers.push({
      strategyId,
      barIndex: i,
      visibleFromIndex: i,
      kind: "entry",
      win: null,
      price: fillPrice,
      side: from.side,
    });
    return {
      strategyId,
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

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (open !== null) {
      const pos = open;
      const stopped =
        pos.side === "long" ? bar.l <= pos.stopPrice : bar.h >= pos.stopPrice;
      const targeted =
        pos.side === "long" ? bar.h >= pos.targetPrice : bar.l <= pos.targetPrice;
      if (!stopped && !targeted) {
        let managed: unknown;
        try {
          managed = fn(bar, i, bars, ta, {
            side: pos.side,
            entry: pos.entryPrice,
            stop: pos.stopPrice,
            target: pos.targetPrice,
            risk: pos.riskPoints,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Script threw.";
          return { ok: false, error: `Bar ${i + 1}: ${message}`, markers: [], trades: [] };
        }
        const nextTarget = readTarget(managed);
        if (nextTarget !== null) pos.targetPrice = nextTarget;
      }
      const exit = resolveExitFill(bar, pos.side, pos.stopPrice, pos.targetPrice);
      if (exit) {
        pos.exitIndex = i;
        pos.exitReason = exit.reason;
        pos.exitPrice = exit.price;
        markers.push({
          strategyId,
          barIndex: i,
          visibleFromIndex: i,
          kind: "exit",
          win: exit.reason === "target",
          price: exit.price,
          side: pos.side,
        });
        trades.push(pos);
        open = null;
      }
      continue;
    }

    if (pending !== null) {
      const fill = resolveEntryLimitFill(bar, pending.side, pending.limit, pending.stop);
      if (fill !== null) {
        const pos = makeOpen(i, fill, pending);
        pending = null;
        const exit = resolveExitFill(bar, pos.side, pos.stopPrice, pos.targetPrice);
        if (exit) {
          pos.exitIndex = i;
          pos.exitReason = exit.reason;
          pos.exitPrice = exit.price;
          markers.push({
            strategyId,
            barIndex: i,
            visibleFromIndex: i,
            kind: "exit",
            win: exit.reason === "target",
            price: exit.price,
            side: pos.side,
          });
          trades.push(pos);
          open = null;
        } else {
          open = pos;
        }
        continue;
      }
      pending.barsWaited += 1;
      if (pending.barsWaited >= expiryBars) {
        pending = null;
      }
      continue;
    }

    let result: unknown;
    try {
      result = fn(bar, i, bars, ta, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Script threw.";
      return { ok: false, error: `Bar ${i + 1}: ${message}`, markers: [], trades: [] };
    }
    const signal = readSignal(result);
    if (!signal) continue;
    const limit = bar.c;
    const risk = Math.max(Math.abs(limit - signal.stop), 0.25);
    markers.push({
      strategyId,
      barIndex: i,
      visibleFromIndex: i,
      kind: "signal",
      win: null,
      price: null,
      side: signal.side,
    });
    if (instantFill) {
      open = makeOpen(i, limit, {
        side: signal.side,
        stop: signal.stop,
        target: signal.target,
        risk,
        signalIndex: i,
      });
      continue;
    }
    pending = {
      side: signal.side,
      stop: signal.stop,
      target: signal.target,
      risk,
      limit,
      signalIndex: i,
      barsWaited: 0,
    };
  }

  if (open) trades.push(open);
  return { ok: true, markers, trades };
}

export const MNQ_POINT_VALUE = 2;

/** Starting net asset for equity curves ($2 per MNQ point is added on top). */
export const STARTING_NET_ASSET = 10_000;

export type EquityPoint = {
  ts: number;
  equity: number;
};

export type BacktestStats = {
  winRate: number | null;
  /** Mean R-multiple of closed trades: points PnL / riskPoints. Null if none closed. */
  averageRr: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  maxDrawdown: number;
  averageHoldMs: number | null;
  longestHoldMs: number | null;
  medianHoldMs: number | null;
  signalCount: number;
  signalIntervalMs: number | null;
  equity: EquityPoint[];
  endingEquity: number;
  /** Peak of the equity curve (includes starting capital). */
  peakEquity: number;
  /** Trough of the equity curve (includes starting capital). */
  troughEquity: number;
  startingEquity: number;
  /** Number of closed trades in this summary. */
  closedTrades: number;
  /** Round-trip fee USD applied per closed trade. */
  feePerTrade: number;
  /** Total fees deducted from closed trades. */
  totalFees: number;
};

function isClosed(
  trade: ScriptTrade,
): trade is ScriptTrade & {
  exitIndex: number;
  exitPrice: number;
  exitReason: "stop" | "target";
} {
  return trade.exitIndex !== null && trade.exitPrice !== null && trade.exitReason !== null;
}

function tradePnl(trade: ScriptTrade, exitPrice: number) {
  const sign = trade.side === "short" ? -1 : 1;
  const points = (exitPrice - trade.entryPrice) * sign;
  return points * MNQ_POINT_VALUE;
}

export function summarizeBacktest(
  run: { markers: ScriptMarker[]; trades: ScriptTrade[] },
  bars: OhlcvBar[],
  feeUsd: number = DEFAULT_ROUND_TRIP_FEE_USD,
): BacktestStats {
  const feePerTrade = normalizeRoundTripFee(feeUsd);
  const closed = run.trades
    .filter(isClosed)
    .sort((left, right) => left.exitIndex - right.exitIndex || left.entryIndex - right.entryIndex);
  let winStreak = 0;
  let lossStreak = 0;
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let wins = 0;
  const holds: number[] = [];
  const rMultiples: number[] = [];
  for (const trade of closed) {
    holds.push(bars[trade.exitIndex].ts - bars[trade.entryIndex].ts);
    const sign = trade.side === "short" ? -1 : 1;
    const points = (trade.exitPrice - trade.entryPrice) * sign;
    if (trade.riskPoints > 0) {
      rMultiples.push(points / trade.riskPoints);
    }
    if (trade.exitReason === "target") {
      wins += 1;
      winStreak += 1;
      lossStreak = 0;
      if (winStreak > maxConsecutiveWins) maxConsecutiveWins = winStreak;
    } else {
      lossStreak += 1;
      winStreak = 0;
      if (lossStreak > maxConsecutiveLosses) maxConsecutiveLosses = lossStreak;
    }
  }

  const equity: EquityPoint[] = [{ ts: bars[0].ts, equity: STARTING_NET_ASSET }];
  let cursorEquity = STARTING_NET_ASSET;
  for (const trade of closed) {
    // Deduct round-trip fee only when the exit fills — not on open MTM.
    cursorEquity += tradePnl(trade, trade.exitPrice) - feePerTrade;
    equity.push({ ts: bars[trade.exitIndex].ts, equity: cursorEquity });
  }
  const totalFees = closed.length * feePerTrade;
  const open = run.trades.find((trade) => trade.exitIndex === null);
  const lastBar = bars[bars.length - 1];
  if (open) {
    cursorEquity += tradePnl(open, lastBar.c);
    equity.push({ ts: lastBar.ts, equity: cursorEquity });
  } else if (equity[equity.length - 1].ts !== lastBar.ts) {
    equity.push({ ts: lastBar.ts, equity: cursorEquity });
  }

  let peak = equity[0]?.equity ?? STARTING_NET_ASSET;
  let trough = peak;
  let maxDrawdown = 0;
  for (const point of equity) {
    if (point.equity > peak) peak = point.equity;
    if (point.equity < trough) trough = point.equity;
    const drop = peak - point.equity;
    if (drop > maxDrawdown) maxDrawdown = drop;
  }

  const spanMs = lastBar.ts - bars[0].ts;
  const signalCount = run.markers.filter((marker) => marker.kind === "signal").length;
  const sortedHolds = [...holds].sort((left, right) => left - right);
  const mid = Math.floor(sortedHolds.length / 2);
  const medianHoldMs =
    sortedHolds.length === 0
      ? null
      : sortedHolds.length % 2 === 1
        ? sortedHolds[mid]
        : (sortedHolds[mid - 1] + sortedHolds[mid]) / 2;
  const holdTotal = holds.reduce((sum, value) => sum + value, 0);

  const rrTotal = rMultiples.reduce((sum, value) => sum + value, 0);

  return {
    winRate: closed.length === 0 ? null : wins / closed.length,
    averageRr: rMultiples.length === 0 ? null : rrTotal / rMultiples.length,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    maxDrawdown,
    averageHoldMs: holds.length === 0 ? null : holdTotal / holds.length,
    longestHoldMs: sortedHolds.length === 0 ? null : sortedHolds[sortedHolds.length - 1],
    medianHoldMs,
    signalCount,
    signalIntervalMs: signalCount === 0 || spanMs <= 0 ? null : spanMs / signalCount,
    equity,
    endingEquity: cursorEquity,
    peakEquity: peak,
    troughEquity: trough,
    startingEquity: STARTING_NET_ASSET,
    closedTrades: closed.length,
    feePerTrade,
    totalFees,
  };
}

export function scoreScript(
  trades: ScriptTrade[],
  bars: OhlcvBar[],
  cursor: number,
  feeUsd: number = DEFAULT_ROUND_TRIP_FEE_USD,
): ScriptScore {
  let realizedPoints = 0;
  let openPoints = 0;
  let closedTrades = 0;
  let openTrades = 0;
  let wins = 0;
  let losses = 0;
  const pointValue = MNQ_POINT_VALUE;
  const feePerTrade = normalizeRoundTripFee(feeUsd);

  for (const trade of trades) {
    if (trade.entryIndex > cursor) continue;
    const sign = trade.side === "short" ? -1 : 1;
    const marked = (price: number) => (price - trade.entryPrice) * sign;
    if (trade.exitIndex !== null && trade.exitPrice !== null && trade.exitIndex <= cursor) {
      realizedPoints += marked(trade.exitPrice);
      closedTrades += 1;
      if (trade.exitReason === "target") wins += 1;
      if (trade.exitReason === "stop") losses += 1;
    } else {
      openPoints += marked(bars[cursor].c);
      openTrades += 1;
    }
  }

  const totalPoints = realizedPoints + openPoints;
  // Dollar PnL nets round-trip fee on closed trades only; open MTM stays points*$2.
  const totalPnl = totalPoints * pointValue - closedTrades * feePerTrade;
  return {
    totalPoints,
    totalPnl,
    realizedPoints,
    openPoints,
    closedTrades,
    openTrades,
    wins,
    losses,
  };
}

export type NamedScriptRun = {
  id: string;
  name: string;
  color: string;
  run: ScriptRun;
};

export type EquitySeries = {
  id: string;
  name: string;
  color: string;
  equity: EquityPoint[];
  endingEquity: number;
  peakEquity: number;
  troughEquity: number;
};

export type MultiBacktestReport = {
  series: EquitySeries[];
  /** Primary stats: combined when multiple series, else the single series. */
  stats: BacktestStats;
  perStrategy: { id: string; name: string; color: string; stats: BacktestStats }[];
};

export const STRATEGY_COLORS = {
  long: "#3dd68c",
  short: "#7aa2ff",
  combined: "#f0c14a",
} as const;

export function mergeScriptRuns(named: NamedScriptRun[]): ScriptRun {
  const okRuns = named.filter((item) => item.run.ok);
  if (okRuns.length === 0) {
    const first = named[0]?.run;
    return first ?? { ok: false, error: "No strategies enabled.", markers: [], trades: [] };
  }
  const failed = named.find((item) => !item.run.ok);
  if (failed && !failed.run.ok) {
    return {
      ok: false,
      error: `${failed.name}: ${failed.run.error}`,
      markers: [],
      trades: [],
    };
  }
  const markers = okRuns.flatMap((item) => item.run.markers);
  const trades = okRuns.flatMap((item) => item.run.trades);
  return { ok: true, markers, trades };
}

export function summarizeMultiBacktest(
  named: NamedScriptRun[],
  bars: OhlcvBar[],
  feeUsd: number = DEFAULT_ROUND_TRIP_FEE_USD,
): MultiBacktestReport | null {
  const okNamed = named.filter((item) => item.run.ok);
  if (okNamed.length === 0 || bars.length === 0) return null;
  const fee = normalizeRoundTripFee(feeUsd);

  const perStrategy = okNamed.map((item) => ({
    id: item.id,
    name: item.name,
    color: item.color,
    stats: summarizeBacktest(item.run, bars, fee),
  }));

  const series: EquitySeries[] = perStrategy.map((item) => ({
    id: item.id,
    name: item.name,
    color: item.color,
    equity: item.stats.equity,
    endingEquity: item.stats.endingEquity,
    peakEquity: item.stats.peakEquity,
    troughEquity: item.stats.troughEquity,
  }));

  const merged = mergeScriptRuns(okNamed);
  const combinedStats = summarizeBacktest(merged, bars, fee);
  if (okNamed.length > 1) {
    series.push({
      id: "combined",
      name: "Combined",
      color: STRATEGY_COLORS.combined,
      equity: combinedStats.equity,
      endingEquity: combinedStats.endingEquity,
      peakEquity: combinedStats.peakEquity,
      troughEquity: combinedStats.troughEquity,
    });
  }

  return {
    series,
    stats: combinedStats,
    perStrategy,
  };
}

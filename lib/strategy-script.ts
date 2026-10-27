import { fillSessionMasks } from "@/lib/chicago-session";
import { ema } from "@/lib/ema";
import type { OhlcvBar } from "@/lib/strategies/types";
import { runGeneratedLegs, type FastLeg } from "@/lib/strategy-fast";

export const STRATEGY_STORAGE_KEY = "mnq-replay.strategyScript";
export const ENTRY_FILTERS_STORAGE_KEY = "mnq-replay.entryFilters";
export const ROUND_TRIP_FEE_STORAGE_KEY = "mnq-replay.roundTripFeeUsd";
export const FLIP_LOCK_BARS_STORAGE_KEY = "mnq-replay.flipLockBars";

/**
 * After a full stop, block new opposite-side entries for this many 1m bars.
 * 0 turns the lock off and is the daytime default. Set above 0 to enable.
 * Eve and single-side runs do not use this lock.
 */
export const DEFAULT_FLIP_LOCK_BARS = 0;

export function normalizeFlipLockBars(raw: unknown, fallback = DEFAULT_FLIP_LOCK_BARS): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(5000, Math.round(n));
}

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

/**
 * vstrict filters for the parked evening candidate.
 * The daytime default stays on DEFAULT_ENTRY_FILTERS.
 */
export const EVE_ENTRY_FILTERS: EntryFilters = {
  bodyRatio: 0.7,
  minBody: 6,
  volLen: 20,
  volMult: 2.2,
};

export const STRATEGY_PRESET_STORAGE_KEY = "mnq-replay.strategyPreset";

export type StrategyPresetId = "day" | "eve";

export const STRATEGY_PRESETS: { id: StrategyPresetId; label: string }[] = [
  { id: "day", label: "Daytime 09:00–20:29 (default)" },
  { id: "eve", label: "Eve 20:30–23:59 · stop2 asym · 2.5R+EMA" },
];

export function normalizeStrategyPreset(raw: unknown): StrategyPresetId {
  return raw === "eve" ? "eve" : "day";
}

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

/** Exact Chicago block embedded in the daytime builders. The engine rewrites this to a mask. */
const DAY_SESSION_SNIPPET = `const ctParts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Chicago", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(bar.ts))
const ctMins = Number(ctParts.find((p) => p.type === "hour")?.value ?? 0) * 60 + Number(ctParts.find((p) => p.type === "minute")?.value ?? 0)
const ctWd = ctParts.find((p) => p.type === "weekday")?.value ?? ""
const sessionOk = ctMins >= 9 * 60 && ctMins < 21 * 60 - 30 && !(ctWd === "Fri" && ctMins >= 14 * 60 + 45)`;

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
${DAY_SESSION_SNIPPET}
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
${DAY_SESSION_SNIPPET}
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

/** Chicago minute-of-day bounds for the evening candidate (20:30 through 23:59 inclusive). */
const EVE_SESSION_START_MINS = 20 * 60 + 30;
const EVE_SESSION_END_MINS = 23 * 60 + 59;

const EVE_SESSION_SNIPPET = `const ctParts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Chicago", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(bar.ts))
const ctMins = Number(ctParts.find((p) => p.type === "hour")?.value ?? 0) * 60 + Number(ctParts.find((p) => p.type === "minute")?.value ?? 0)
const sessionOk = ctMins >= ${EVE_SESSION_START_MINS} && ctMins <= ${EVE_SESSION_END_MINS}`;

function buildEveLegScript(side: "long" | "short", filters: EntryFilters): string {
  const f = clampFilters(filters);
  const bearish = side === "short";
  const riskExpr = bearish ? "Math.max(bar.h - bar.c, 1)" : "Math.max(bar.c - bar.l, 1)";
  const stopExpr = bearish ? "bar.c + risk1 * 2" : "bar.c - risk1 * 2";
  const targetExpr = bearish ? "bar.c - risk1 * 2.5" : "bar.c + risk1 * 2.5";
  const emaCmp = bearish ? "bar.c > ema5" : "bar.c < ema5";
  const emaTarget = bearish ? "position.entry - position.risk" : "position.entry + position.risk";
  const impulseCmp = bearish ? "<" : ">";
  const extremeName = bearish ? "high" : "low";
  return `// PRESET=eve-2030-2359
// Eve baseline candidate (parked for later review — not the daytime default).
// MNQ 1-minute ${side} impulse. Entries only America/Chicago 20:30–23:59 (not the rest of the overnight session).
// vstrict filters: body/range >= ${f.bodyRatio}, body >= ${f.minBody}, vol > SMA(${f.volLen}) * ${f.volMult}
// stopMult=2 asym: risk1 = max(|close - ${extremeName}|, 1); stop is 2×risk1 from the close.
// Target is 2.5× risk1. A 5 EMA cross tightens the target to 1× risk1 (position.risk), not to the widened stop.
// Entry is a limit at the signal close; expires after 2 completed 1m bars if unfilled. One position at a time.
// Pair with the other Eve leg for combined long+short. Fee $1.6 and 1 contract are app settings.
// Snapshot on the 41581-bar file (not live truth): ~$10642 final asset · MaxDD $185 · WR 69% · n=62.
// Page Avg RR uses risk1 (~+0.38R there). An earlier +0.19 counted R off the 2× stop.

const ema5 = ta.ema(i, 5, "c")
if (position && position.side === "${side}" && ${emaCmp}) {
  return { target: ${emaTarget} }
}

// EVE_SESSION=20:30–23:59 America/Chicago. No Friday cutoff. Hours outside this window do not enter.
${EVE_SESSION_SNIPPET}
const avgVol = ta.sma(i, ${f.volLen}, "v")
const body = Math.abs(bar.c - bar.o)
const span = Math.max(bar.h - bar.l, 0.25)
if (!position && sessionOk && bar.c ${impulseCmp} bar.o && body / span >= ${f.bodyRatio} && body >= ${f.minBody} && bar.v > avgVol * ${f.volMult}) {
  const risk1 = ${riskExpr}
  return { signal: true, side: "${side}", stop: ${stopExpr}, target: ${targetExpr}, risk: risk1 }
}
return null
`;
}

export function buildEveLongStrategyScript(filters: EntryFilters = EVE_ENTRY_FILTERS): string {
  return buildEveLegScript("long", filters);
}

export function buildEveShortStrategyScript(filters: EntryFilters = EVE_ENTRY_FILTERS): string {
  return buildEveLegScript("short", filters);
}

export const EVE_LONG_STRATEGY_SCRIPT = buildEveLongStrategyScript();
export const EVE_SHORT_STRATEGY_SCRIPT = buildEveShortStrategyScript();

export function isStaleDefaultScript(script: string) {
  // The evening candidate is its own preset, not an outdated daytime default.
  if (script.includes("PRESET=eve-2030-2359")) return false;
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

type TaApi = {
  sma: (index: number, length: number, field: Field) => number;
  ema: (index: number, length: number, field: Field) => number;
  daySession: (index: number) => boolean;
  eveSession: (index: number) => boolean;
};

type BarFn = (
  bar: OhlcvBar,
  i: number,
  bars: OhlcvBar[],
  ta: TaApi,
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
  /**
   * Original risk1 when the script uses an asymmetric stop.
   * Null means R is |signal close − stop|, which is the daytime default.
   */
  risk: number | null;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const record = Object.fromEntries(Object.entries(value));
  if (record.signal !== true) return null;
  const side = record.side === "short" ? "short" : "long";
  const stop = readNumber(record, "stop");
  const target = readNumber(record, "target");
  if (stop === null || target === null) return null;
  const risk = readNumber(record, "risk");
  return {
    side,
    stop,
    target,
    risk: risk !== null && risk > 0 ? risk : null,
  };
}


/** Completed 1m bars after the signal bar an unfilled entry limit may wait (matches paper). */
export const ENTRY_LIMIT_EXPIRY_BARS = 2;

/**
 * Pending entry limit fill (paper Limit @ signal close).
 * Long buy-limit: fill if traded at/through limit without already opening through stop.
 * Short sell-limit: mirror.
 * Returns fill price or null.
 */
export function resolveEntryLimitFill(
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
export function resolveExitFill(
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
  /**
   * After a closed trade exits on a full stop at bar E, reject new entries on the
   * opposite side whose signal bar is in E+1 .. E+flipLockBars (inclusive).
   * Same-side entries stay allowed. A pending limit whose signal bar is already
   * accepted can still fill inside the window. `0` disables.
   * Omitted on `runStrategyScript` means off, so a single leg cannot see the other side.
   * Omitted on `runLinkedStrategyScripts` means `DEFAULT_FLIP_LOCK_BARS` (0, off).
   */
  flipLockBars?: number;
  /**
   * Run the user script as written, including per-bar Chicago Intl.
   * The default path uses a native loop for generated daytime/eve scripts
   * and a precomputed session mask for scripts that still contain that block.
   */
  forceInterpreter?: boolean;
};

type PendingEntry = {
  side: "long" | "short";
  stop: number;
  target: number;
  risk: number;
  limit: number;
  signalIndex: number;
  barsWaited: number;
};

export type FlipLock = {
  /** Stop exit bar. A signal on this same bar is still allowed. */
  fromBar: number;
  /** Last blocked signal bar: exitIndex + flipLockBars. */
  untilBar: number;
  stopSide: "long" | "short";
};

type StrategyLeg = {
  id: string;
  fn: BarFn;
  ta: TaApi;
  markers: ScriptMarker[];
  trades: ScriptTrade[];
  open: ScriptTrade | null;
  pending: PendingEntry | null;
};

/** Append a lock when a trade exits on a full stop. Target exits and `flipLockBars <= 0` do nothing. */
export function noteStopFlipLock(
  locks: FlipLock[],
  flipLockBars: number,
  exitIndex: number,
  stopSide: "long" | "short",
  reason: "stop" | "target",
) {
  if (flipLockBars <= 0 || reason !== "stop") return;
  locks.push({
    fromBar: exitIndex,
    untilBar: exitIndex + flipLockBars,
    stopSide,
  });
}

/**
 * True when `signalIndex` is strictly after a stop and still inside that lock.
 * Same-side signals return false. Paper's Python mirror (`paper/flip_lock.py`)
 * must stay aligned with this function.
 */
export function isOppositeFlipLocked(
  locks: FlipLock[],
  side: "long" | "short",
  signalIndex: number,
): boolean {
  for (const lock of locks) {
    if (signalIndex <= lock.fromBar) continue;
    if (signalIndex > lock.untilBar) continue;
    if (side !== lock.stopSide) return true;
  }
  return false;
}

function accelerateSession(source: string): string {
  if (source.includes(DAY_SESSION_SNIPPET)) {
    return source.replaceAll(DAY_SESSION_SNIPPET, "const sessionOk = ta.daySession(i)");
  }
  if (source.includes(EVE_SESSION_SNIPPET)) {
    return source.replaceAll(EVE_SESSION_SNIPPET, "const sessionOk = ta.eveSession(i)");
  }
  return source;
}

const FILTER_NUMBERS =
  /body\/range >= ([0-9.]+), body >= ([0-9.]+), vol > SMA\(([0-9]+)\) \* ([0-9.]+)/;

function classifyGeneratedLeg(id: string, source: string): FastLeg | null {
  const match = FILTER_NUMBERS.exec(source);
  if (!match) return null;
  const filters = normalizeEntryFilters({
    bodyRatio: Number(match[1]),
    minBody: Number(match[2]),
    volLen: Number(match[3]),
    volMult: Number(match[4]),
  });
  if (source === buildLongStrategyScript(filters)) return { id, kind: "day", side: "long", filters };
  if (source === buildShortStrategyScript(filters)) return { id, kind: "day", side: "short", filters };
  if (source === buildEveLongStrategyScript(filters)) {
    return { id, kind: "eve", side: "long", filters };
  }
  if (source === buildEveShortStrategyScript(filters)) {
    return { id, kind: "eve", side: "short", filters };
  }
  return null;
}

function sessionMasks(bars: OhlcvBar[]): { day: Uint8Array; eve: Uint8Array } {
  const day = new Uint8Array(bars.length);
  const eve = new Uint8Array(bars.length);
  const tsMs = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i += 1) tsMs[i] = bars[i].ts;
  fillSessionMasks(tsMs, day, eve);
  return { day, eve };
}

function makeTa(
  bars: OhlcvBar[],
  emaCache: Map<string, (number | null)[]>,
  sessions: { day: Uint8Array; eve: Uint8Array } | null,
): StrategyLeg["ta"] {
  return {
    daySession(index: number) {
      return sessions !== null && sessions.day[index] === 1;
    },
    eveSession(index: number) {
      return sessions !== null && sessions.eve[index] === 1;
    },
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
}

export type LinkedStrategySpec = {
  id: string;
  source: string;
};

export type LinkedStrategyRun =
  | { ok: true; runs: { id: string; run: ScriptRun }[] }
  | { ok: false; error: string };

/**
 * Run one or more scripts on the same bars with one shared flip lock.
 * Long and short daytime legs must go through here together; separate
 * `runStrategyScript` calls cannot see each other's stops.
 */
export function runLinkedStrategyScripts(
  bars: OhlcvBar[],
  specs: LinkedStrategySpec[],
  options: RunStrategyOptions = {},
): LinkedStrategyRun {
  const expiryBars =
    options.entryLimitExpiryBars === undefined
      ? ENTRY_LIMIT_EXPIRY_BARS
      : options.entryLimitExpiryBars;
  const instantFill = expiryBars <= 0;
  const flipLockBars =
    options.flipLockBars === undefined
      ? DEFAULT_FLIP_LOCK_BARS
      : normalizeFlipLockBars(options.flipLockBars, 0);

  if (!options.forceInterpreter) {
    const classified: FastLeg[] = [];
    let allKnown = specs.length > 0;
    for (const spec of specs) {
      const leg = classifyGeneratedLeg(spec.id, spec.source);
      if (!leg) {
        allKnown = false;
        break;
      }
      classified.push(leg);
    }
    if (allKnown) {
      return runGeneratedLegs(bars, classified, {
        entryLimitExpiryBars: expiryBars,
        flipLockBars,
      });
    }
  }

  const sources = specs.map((spec) =>
    options.forceInterpreter ? spec.source : accelerateSession(spec.source),
  );
  const sessions = sources.some((source, index) => source !== specs[index]?.source)
    ? sessionMasks(bars)
    : null;

  const legs: StrategyLeg[] = [];
  for (let specIndex = 0; specIndex < specs.length; specIndex += 1) {
    const spec = specs[specIndex];
    const source = sources[specIndex] ?? spec.source;
    try {
      legs.push({
        id: spec.id,
        fn: compile(source),
        ta: makeTa(bars, new Map(), sessions),
        markers: [],
        trades: [],
        open: null,
        pending: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Script failed to compile.";
      return { ok: false, error: `${spec.id}: ${message}` };
    }
  }

  const locks: FlipLock[] = [];

  const pushExit = (
    leg: StrategyLeg,
    pos: ScriptTrade,
    i: number,
    exit: { price: number; reason: "stop" | "target" },
  ) => {
    pos.exitIndex = i;
    pos.exitReason = exit.reason;
    pos.exitPrice = exit.price;
    leg.markers.push({
      strategyId: leg.id,
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
    leg: StrategyLeg,
    i: number,
    fillPrice: number,
    from: { side: "long" | "short"; stop: number; target: number; risk: number; signalIndex: number },
  ): ScriptTrade => {
    leg.markers.push({
      strategyId: leg.id,
      barIndex: i,
      visibleFromIndex: i,
      kind: "entry",
      win: null,
      price: fillPrice,
      side: from.side,
    });
    return {
      strategyId: leg.id,
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
    for (const leg of legs) {
      if (leg.open !== null) {
        const pos = leg.open;
        const stopped = pos.side === "long" ? bar.l <= pos.stopPrice : bar.h >= pos.stopPrice;
        const targeted = pos.side === "long" ? bar.h >= pos.targetPrice : bar.l <= pos.targetPrice;
        if (!stopped && !targeted) {
          let managed: unknown;
          try {
            managed = leg.fn(bar, i, bars, leg.ta, {
              side: pos.side,
              entry: pos.entryPrice,
              stop: pos.stopPrice,
              target: pos.targetPrice,
              risk: pos.riskPoints,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Script threw.";
            return { ok: false, error: `${leg.id}: Bar ${i + 1}: ${message}` };
          }
          const nextTarget = readTarget(managed);
          if (nextTarget !== null) pos.targetPrice = nextTarget;
        }
        const exit = resolveExitFill(bar, pos.side, pos.stopPrice, pos.targetPrice);
        if (exit) {
          pushExit(leg, pos, i, exit);
          leg.open = null;
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
          } else {
            leg.open = pos;
          }
          continue;
        }
        pending.barsWaited += 1;
        if (pending.barsWaited >= expiryBars) {
          leg.pending = null;
        }
        continue;
      }

      let result: unknown;
      try {
        result = leg.fn(bar, i, bars, leg.ta, null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Script threw.";
        return { ok: false, error: `${leg.id}: Bar ${i + 1}: ${message}` };
      }
      const signal = readSignal(result);
      if (!signal) continue;
      if (isOppositeFlipLocked(locks, signal.side, i)) continue;
      const limit = bar.c;
      const stopDistance = Math.max(Math.abs(limit - signal.stop), 0.25);
      // Asym stops pass risk1 explicitly so 2.5R, EMA→1R, and Avg RR use it.
      // Daytime scripts omit risk, so R stays the distance from the close to the stop.
      const risk = signal.risk ?? stopDistance;
      leg.markers.push({
        strategyId: leg.id,
        barIndex: i,
        visibleFromIndex: i,
        kind: "signal",
        win: null,
        price: null,
        side: signal.side,
      });
      if (instantFill) {
        leg.open = makeOpen(leg, i, limit, {
          side: signal.side,
          stop: signal.stop,
          target: signal.target,
          risk,
          signalIndex: i,
        });
        continue;
      }
      leg.pending = {
        side: signal.side,
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
      id: leg.id,
      run: { ok: true as const, markers: leg.markers, trades: leg.trades },
    })),
  };
}

export function runStrategyScript(
  bars: OhlcvBar[],
  source: string,
  strategyId = "script",
  options: RunStrategyOptions = {},
): ScriptRun {
  const linked = runLinkedStrategyScripts(bars, [{ id: strategyId, source }], {
    ...options,
    // A lone script has no other side to lock. Callers that want the shared
    // daytime lock use runLinkedStrategyScripts (default 0, off).
    flipLockBars: options.flipLockBars ?? 0,
  });
  if (!linked.ok) {
    const prefix = `${strategyId}: `;
    const error = linked.error.startsWith(prefix) ? linked.error.slice(prefix.length) : linked.error;
    return { ok: false, error, markers: [], trades: [] };
  }
  return linked.runs[0]?.run ?? { ok: true, markers: [], trades: [] };
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

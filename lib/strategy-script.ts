import type { OhlcvBar } from "@/lib/strategies/types";

export const STRATEGY_STORAGE_KEY = "mnq-replay.strategyScript";

export const DEFAULT_STRATEGY_SCRIPT = `// MNQ 1-minute strategy. This runs in the browser on each bar.
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

export type ScriptMarker = {
  barIndex: number;
  visibleFromIndex: number;
  kind: "signal" | "entry" | "exit";
  win: boolean | null;
  price: number | null;
  side: "long" | "short" | null;
};

export type ScriptTrade = {
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
  totalR: number;
  totalPnl: number;
  realizedR: number;
  openR: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
};

export type ScriptRun =
  | { ok: true; markers: ScriptMarker[]; trades: ScriptTrade[] }
  | { ok: false; error: string; markers: ScriptMarker[]; trades: ScriptTrade[] };

type Field = "o" | "h" | "l" | "c" | "v";

type BarFn = (
  bar: OhlcvBar,
  i: number,
  bars: OhlcvBar[],
  ta: {
    sma: (index: number, length: number, field: Field) => number;
  },
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

function compile(source: string): BarFn {
  const created: unknown = new Function(
    "bar",
    "i",
    "bars",
    "ta",
    `"use strict";\n${source}`,
  );
  if (!isBarFn(created)) {
    throw new Error("Script did not compile.");
  }
  return created;
}

export function runStrategyScript(bars: OhlcvBar[], source: string): ScriptRun {
  let fn: BarFn;
  try {
    fn = compile(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Script failed to compile.";
    return { ok: false, error: message, markers: [], trades: [] };
  }

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
  };

  const markers: ScriptMarker[] = [];
  const trades: ScriptTrade[] = [];
  let open: ScriptTrade | null = null;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (open) {
      const stopped =
        open.side === "long" ? bar.l <= open.stopPrice : bar.h >= open.stopPrice;
      const targeted =
        open.side === "long" ? bar.h >= open.targetPrice : bar.l <= open.targetPrice;
      if (stopped || targeted) {
        const reason = stopped ? "stop" : "target";
        open.exitIndex = i;
        open.exitReason = reason;
        open.exitPrice = reason === "stop" ? open.stopPrice : open.targetPrice;
        markers.push({
          barIndex: i,
          visibleFromIndex: i,
          kind: "exit",
          win: reason === "target",
          price: reason === "stop" ? open.stopPrice : open.targetPrice,
          side: open.side,
        });
        trades.push(open);
        open = null;
      }
      continue;
    }

    let result: unknown;
    try {
      result = fn(bar, i, bars, ta);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Script threw.";
      return { ok: false, error: `Bar ${i + 1}: ${message}`, markers: [], trades: [] };
    }
    const signal = readSignal(result);
    if (!signal) continue;
    const entry = bar.c;
    const risk = Math.max(Math.abs(entry - signal.stop), 0.25);
    markers.push({
      barIndex: i,
      visibleFromIndex: i,
      kind: "signal",
      win: null,
      price: null,
      side: signal.side,
    });
    markers.push({
      barIndex: i,
      visibleFromIndex: i,
      kind: "entry",
      win: null,
      price: entry,
      side: signal.side,
    });
    open = {
      side: signal.side,
      signalIndex: i,
      entryIndex: i,
      exitIndex: null,
      entryPrice: entry,
      stopPrice: signal.stop,
      targetPrice: signal.target,
      exitPrice: null,
      exitReason: null,
      riskPoints: risk,
    };
  }

  if (open) trades.push(open);
  return { ok: true, markers, trades };
}

export function scoreScript(
  trades: ScriptTrade[],
  bars: OhlcvBar[],
  cursor: number,
): ScriptScore {
  let realizedR = 0;
  let openR = 0;
  let closedTrades = 0;
  let openTrades = 0;
  let wins = 0;
  let losses = 0;
  const pointValue = 2;

  for (const trade of trades) {
    if (trade.entryIndex > cursor) continue;
    const sign = trade.side === "short" ? -1 : 1;
    const marked = (price: number) => ((price - trade.entryPrice) * sign) / trade.riskPoints;
    if (trade.exitIndex !== null && trade.exitPrice !== null && trade.exitIndex <= cursor) {
      realizedR += marked(trade.exitPrice);
      closedTrades += 1;
      if (trade.exitReason === "target") wins += 1;
      if (trade.exitReason === "stop") losses += 1;
    } else {
      openR += marked(bars[cursor].c);
      openTrades += 1;
    }
  }

  const totalR = realizedR + openR;
  return {
    totalR,
    totalPnl: totalR * pointValue,
    realizedR,
    openR,
    closedTrades,
    openTrades,
    wins,
    losses,
  };
}

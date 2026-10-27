import assert from "node:assert/strict";
import test from "node:test";
import type { OhlcvBar } from "./strategies/types.ts";
import {
  DEFAULT_FLIP_LOCK_BARS,
  normalizeFlipLockBars,
  runLinkedStrategyScripts,
  runStrategyScript,
  type ScriptTrade,
} from "./strategy-script.ts";

function series(
  count: number,
  patches: Record<number, Partial<OhlcvBar>> = {},
): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  for (let i = 0; i < count; i += 1) {
    bars.push({
      ts: Date.UTC(2026, 9, 26, 15, 0) + i * 60_000,
      o: 100,
      h: 100.5,
      l: 99.5,
      c: 100,
      v: 1,
      ...patches[i],
    });
  }
  return bars;
}

function leg(side: "long" | "short", indexes: number[]): string {
  const stop = side === "long" ? 98 : 102;
  const target = side === "long" ? 130 : 70;
  const ready = indexes.length === 0 ? "false" : indexes.map((index) => `i === ${index}`).join(" || ");
  return `
    if (!position && (${ready})) {
      return { signal: true, side: "${side}", stop: ${stop}, target: ${target} }
    }
    return null
  `;
}

function closed(trades: ScriptTrade[]) {
  return trades.filter((trade) => trade.exitIndex != null);
}

function runPair(
  bars: OhlcvBar[],
  longAt: number[],
  shortAt: number[],
  flipLockBars: number | undefined,
  entryLimitExpiryBars = 0,
) {
  const linked = runLinkedStrategyScripts(
    bars,
    [
      { id: "long", source: leg("long", longAt) },
      { id: "short", source: leg("short", shortAt) },
    ],
    {
      entryLimitExpiryBars,
      ...(flipLockBars === undefined ? {} : { flipLockBars }),
    },
  );
  assert.equal(linked.ok, true, linked.ok ? "" : linked.error);
  if (!linked.ok) throw new Error(linked.error);
  const longRun = linked.runs.find((item) => item.id === "long")?.run;
  const shortRun = linked.runs.find((item) => item.id === "short")?.run;
  assert.ok(longRun?.ok && shortRun?.ok);
  return { longRun, shortRun };
}

test("normalizeFlipLockBars keeps 0 as off and falls back when the value is unusable", () => {
  assert.equal(DEFAULT_FLIP_LOCK_BARS, 0);
  assert.equal(normalizeFlipLockBars(0), 0);
  assert.equal(normalizeFlipLockBars("0"), 0);
  assert.equal(normalizeFlipLockBars(15.4), 15);
  assert.equal(normalizeFlipLockBars(-3), 0);
  assert.equal(normalizeFlipLockBars("nope"), 0);
  assert.equal(normalizeFlipLockBars(-3, 15), 15);
  assert.equal(normalizeFlipLockBars(-3, 0), 0);
});

test("flip lock blocks the opposite side for the next 15 signal bars after a stop", () => {
  const bars = series(30, { 6: { l: 97 } });
  const { longRun, shortRun } = runPair(bars, [5], [7, 21, 22], 15);
  assert.equal(longRun.trades[0]?.exitIndex, 6);
  assert.equal(longRun.trades[0]?.exitReason, "stop");
  assert.deepEqual(
    shortRun.trades.map((trade) => trade.signalIndex),
    [22],
  );
  assert.equal(shortRun.markers.some((marker) => marker.kind === "signal" && marker.barIndex === 7), false);
  assert.equal(shortRun.markers.some((marker) => marker.kind === "signal" && marker.barIndex === 21), false);
  assert.equal(shortRun.markers.some((marker) => marker.kind === "signal" && marker.barIndex === 22), true);
});

test("linked runner defaults to flip lock off", () => {
  const bars = series(30, { 6: { l: 97 } });
  const { shortRun } = runPair(bars, [5], [7, 22], undefined);
  assert.deepEqual(
    shortRun.trades.map((trade) => trade.signalIndex),
    [7],
  );
});

test("a signal on the stop bar is still allowed, and same-side entries stay open", () => {
  const bars = series(20, { 6: { l: 97 } });
  const sameBar = runPair(bars, [5], [6], 15);
  assert.equal(sameBar.shortRun.trades[0]?.signalIndex, 6);

  const sameSide = runPair(bars, [5, 8], [7], 15);
  assert.deepEqual(
    sameSide.longRun.trades.map((trade) => trade.signalIndex),
    [5, 8],
  );
  assert.equal(sameSide.shortRun.trades.length, 0);
});

test("flip lock 0 and a target exit do not block the other side", () => {
  const stopped = series(12, { 6: { l: 97 } });
  const unlocked = runPair(stopped, [5], [7], 0);
  assert.equal(unlocked.shortRun.trades[0]?.signalIndex, 7);

  const targeted = series(12, { 6: { h: 131 } });
  const onTarget = runPair(targeted, [5], [7], 15);
  assert.equal(onTarget.longRun.trades[0]?.exitReason, "target");
  assert.equal(onTarget.shortRun.trades[0]?.signalIndex, 7);
});

test("a later opposite stop starts a new lock", () => {
  const bars = series(45, {
    6: { l: 97 },
    23: { h: 103 },
  });
  const { longRun, shortRun } = runPair(bars, [5, 24, 39], [22], 15);
  assert.equal(shortRun.trades[0]?.signalIndex, 22);
  assert.equal(shortRun.trades[0]?.exitIndex, 23);
  assert.equal(shortRun.trades[0]?.exitReason, "stop");
  assert.deepEqual(
    longRun.trades.map((trade) => trade.signalIndex),
    [5, 39],
  );
});

test("a pending limit accepted before the stop can still fill inside the lock", () => {
  const bars = series(12, {
    5: { o: 99, h: 99.4, l: 97, c: 99 },
    6: { o: 99.2, h: 100.2, l: 99, c: 99.5 },
  });
  const { longRun, shortRun } = runPair(bars, [1], [4], 15, 2);
  assert.equal(longRun.trades[0]?.exitIndex, 5);
  assert.equal(longRun.trades[0]?.exitReason, "stop");
  assert.equal(shortRun.trades.length, 1);
  assert.equal(shortRun.trades[0]?.signalIndex, 4);
  assert.equal(shortRun.trades[0]?.entryIndex, 6);
});

test("an expired pending signal does not leave a new opposite entry inside the lock", () => {
  const bars = series(12, {
    5: { o: 99, h: 99.4, l: 97, c: 99 },
    6: { o: 99, h: 99.4, l: 99, c: 99 },
    8: { o: 100, h: 100.5, l: 99.5, c: 100 },
  });
  const locked = runPair(bars, [1], [4, 7], 15, 2);
  assert.equal(locked.shortRun.trades.length, 0);
  const open = runPair(bars, [1], [4, 7], 0, 2);
  assert.equal(open.shortRun.trades[0]?.signalIndex, 7);
});

test("separate runStrategyScript calls do not share a flip lock", () => {
  const bars = series(12, { 6: { l: 97 } });
  const longRun = runStrategyScript(bars, leg("long", [5]), "long", { entryLimitExpiryBars: 0 });
  const shortRun = runStrategyScript(bars, leg("short", [7]), "short", { entryLimitExpiryBars: 0 });
  assert.equal(longRun.ok && shortRun.ok, true);
  if (!longRun.ok || !shortRun.ok) return;
  assert.equal(longRun.trades[0]?.exitReason, "stop");
  assert.equal(shortRun.trades[0]?.signalIndex, 7);
  assert.equal(closed(shortRun.trades).length >= 0, true);
});

test("one script can lock its own opposite signals when flipLockBars is passed", () => {
  const bars = series(30, { 6: { l: 97 } });
  const source = `
    if (!position && i === 5) return { signal: true, side: "long", stop: 98, target: 130 }
    if (!position && i === 7) return { signal: true, side: "short", stop: 102, target: 70 }
    if (!position && i === 22) return { signal: true, side: "short", stop: 102, target: 70 }
    return null
  `;
  const locked = runStrategyScript(bars, source, "mixed", {
    entryLimitExpiryBars: 0,
    flipLockBars: 15,
  });
  const unlocked = runStrategyScript(bars, source, "mixed", { entryLimitExpiryBars: 0 });
  assert.equal(locked.ok && unlocked.ok, true);
  if (!locked.ok || !unlocked.ok) return;
  assert.deepEqual(
    locked.trades.map((trade) => trade.signalIndex),
    [5, 22],
  );
  assert.deepEqual(
    unlocked.trades.map((trade) => trade.signalIndex),
    [5, 7],
  );
});

test("runStrategyScript error text stays bar-scoped", () => {
  const bars = series(3);
  const run = runStrategyScript(bars, `if (i === 1) throw new Error("boom")\nreturn null`, "script");
  assert.equal(run.ok, false);
  if (run.ok) return;
  assert.equal(run.error, "Bar 2: boom");
});

import assert from "node:assert/strict";
import test from "node:test";
import type { OhlcvBar } from "./strategies/types.ts";
import {
  HYBRID_DOWN_HALF_AS_R,
  HYBRID_LOOKBACK,
  HYBRID_REWARD_MULTIPLE,
  HYBRID_TICK,
  HYBRID_UP_HALF_AS_R,
  hybridSignalOf,
  lookbackHighInclusive,
  lookbackLowInclusive,
} from "./strategy-fast.ts";
import {
  DEFAULT_ENTRY_FILTERS,
  buildLongStrategyScript,
  buildShortStrategyScript,
  runLinkedStrategyScripts,
  runStrategyScript,
  type ScriptRun,
} from "./strategy-script.ts";

/** Monday 2026-10-26 15:00 UTC = 10:00 CT (day session). */
function ts(i: number): number {
  return Date.UTC(2026, 9, 26, 15, 0) + i * 60_000;
}

function bar(i: number, o: number, h: number, l: number, c: number, v = 10): OhlcvBar {
  return { ts: ts(i), o, h, l, c, v };
}

function trendBars(n: number, rising: boolean): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  for (let i = 0; i < n; i += 1) {
    const base = rising ? 100 + i * 0.5 : 200 - i * 0.5;
    bars.push(bar(i, base, base + 0.25, base - 0.25, base, 10));
  }
  return bars;
}

test("DEFAULT_ENTRY_FILTERS match Paper hybrid vol knobs", () => {
  assert.deepEqual(DEFAULT_ENTRY_FILTERS, {
    bodyRatio: 0,
    minBody: 0,
    volLen: 10,
    volMult: 1.8,
  });
});

test("hybrid long up-bar uses rewardMultiple to inclusive 50H", () => {
  const bars = trendBars(120, true);
  const i = 110;
  const entry = bars[i - 1].c + 0.5;
  const h50Candidate = entry + 7;
  bars[i] = bar(i, entry - 1, h50Candidate, entry - 1.5, entry, 5000);
  // Fake stacked EMA values (caller supplies).
  const sig = hybridSignalOf(
    "long",
    bars[i],
    bars,
    i,
    true,
    10,
    1.8,
    150,
    140,
    130,
  );
  assert.ok(sig);
  const h50 = lookbackHighInclusive(bars, i, HYBRID_LOOKBACK);
  assert.equal(sig!.target, h50);
  const risk = (h50 - entry) / HYBRID_REWARD_MULTIPLE;
  assert.ok(Math.abs(sig!.risk - risk) < 1e-9);
  assert.ok(Math.abs(sig!.stop - (entry - risk)) < 1e-9);
});

test("hybrid long down-bar uses halfDist as 2R", () => {
  const bars = trendBars(120, true);
  const i = 110;
  const entry = bars[i - 1].c;
  const h50Candidate = entry + 8;
  bars[i] = bar(i, entry + 1, h50Candidate, entry - 0.5, entry, 5000);
  const sig = hybridSignalOf("long", bars[i], bars, i, true, 10, 1.8, 150, 140, 130);
  assert.ok(sig);
  const h50 = lookbackHighInclusive(bars, i, HYBRID_LOOKBACK);
  const half = (h50 - entry) / 2;
  assert.ok(half >= HYBRID_TICK);
  assert.ok(Math.abs(sig!.target - (entry + half)) < 1e-9);
  assert.ok(Math.abs(sig!.risk - half / HYBRID_DOWN_HALF_AS_R) < 1e-9);
  assert.ok(Math.abs(sig!.stop - (entry - half / HYBRID_DOWN_HALF_AS_R)) < 1e-9);
});

test("hybrid short up-bar uses halfDist as 2R (mirror)", () => {
  const bars = trendBars(120, false);
  const i = 110;
  const entry = bars[i - 1].c;
  const l50Candidate = entry - 8;
  bars[i] = bar(i, entry - 1, entry + 0.5, l50Candidate, entry, 5000);
  const sig = hybridSignalOf("short", bars[i], bars, i, true, 10, 1.8, 100, 110, 120);
  assert.ok(sig);
  const l50 = lookbackLowInclusive(bars, i, HYBRID_LOOKBACK);
  const half = (entry - l50) / 2;
  assert.ok(Math.abs(sig!.target - (entry - half)) < 1e-9);
  assert.ok(Math.abs(sig!.risk - half / HYBRID_UP_HALF_AS_R) < 1e-9);
  assert.ok(Math.abs(sig!.stop - (entry + half / HYBRID_UP_HALF_AS_R)) < 1e-9);
});

test("hybrid short down-bar uses rewardMultiple to inclusive 50L", () => {
  const bars = trendBars(120, false);
  const i = 110;
  const entry = bars[i - 1].c - 0.5;
  const l50Candidate = entry - 7;
  bars[i] = bar(i, entry + 1, entry + 1.5, l50Candidate, entry, 5000);
  const sig = hybridSignalOf("short", bars[i], bars, i, true, 10, 1.8, 100, 110, 120);
  assert.ok(sig);
  const l50 = lookbackLowInclusive(bars, i, HYBRID_LOOKBACK);
  assert.equal(sig!.target, l50);
  const risk = (entry - l50) / HYBRID_REWARD_MULTIPLE;
  assert.ok(Math.abs(sig!.risk - risk) < 1e-9);
  assert.ok(Math.abs(sig!.stop - (entry + risk)) < 1e-9);
});

test("no signal when volume below threshold (no look-ahead on later bars)", () => {
  const bars = trendBars(120, true);
  const i = 110;
  const entry = bars[i - 1].c + 0.5;
  bars[i] = bar(i, entry - 1, entry + 7, entry - 1.5, entry, 1); // low volume
  const sig = hybridSignalOf("long", bars[i], bars, i, true, 10, 1.8, 150, 140, 130);
  assert.equal(sig, null);
});

function signature(run: ScriptRun): string {
  assert.equal(run.ok, true, run.ok ? "" : run.error);
  if (!run.ok) return "";
  return JSON.stringify({ markers: run.markers, trades: run.trades });
}

test("generated hybrid long/short fast path matches interpreter", () => {
  // Synthetic rising then mixed session bars — enough for EMA100 warmup.
  const bars = trendBars(250, true);
  // Sprinkle volume spikes on a few day-session bars so signals can fire.
  for (const i of [120, 140, 160, 180, 200]) {
    const b = bars[i];
    bars[i] = { ...b, v: 5000, h: b.c + 5, o: b.c - 0.5, l: b.c - 1 };
  }
  const longSource = buildLongStrategyScript();
  const shortSource = buildShortStrategyScript();
  assert.ok(longSource.includes("PRESET=stacked-ema-hybrid"));
  assert.ok(shortSource.includes("PRESET=stacked-ema-hybrid"));

  const fastLong = runStrategyScript(bars, longSource, "long");
  const slowLong = runStrategyScript(bars, longSource, "long", { forceInterpreter: true });
  assert.equal(signature(fastLong), signature(slowLong));

  const fastShort = runStrategyScript(bars, shortSource, "short");
  const slowShort = runStrategyScript(bars, shortSource, "short", { forceInterpreter: true });
  assert.equal(signature(fastShort), signature(slowShort));

  const specs = [
    { id: "long", source: longSource },
    { id: "short", source: shortSource },
  ];
  const fastLinked = runLinkedStrategyScripts(bars, specs, { flipLockBars: 0 });
  const slowLinked = runLinkedStrategyScripts(bars, specs, {
    flipLockBars: 0,
    forceInterpreter: true,
  });
  assert.equal(fastLinked.ok, true);
  assert.equal(slowLinked.ok, true);
  assert.equal(JSON.stringify(fastLinked), JSON.stringify(slowLinked));
});

test("pending entry cancels when stop is touched before fill (no look-ahead fill)", () => {
  // Hand-built: signal on bar 0 via a custom script is hard; use hybrid builders
  // with forceInterpreter on a tiny crafted series after EMA warmup is impractical.
  // Instead assert resolve path via linked run on a script that signals at i=5.
  const bars: OhlcvBar[] = [];
  for (let i = 0; i < 12; i += 1) {
    bars.push(bar(i, 100, 100.5, 99.5, 100, 1));
  }
  // Signal long at i=5: stop 99, target 110, limit at 100.
  const source = `
    // PRESET=stacked-ema-hybrid
    if (!position && i === 5) {
      return { signal: true, side: "long", stop: 99, target: 110, risk: 1 }
    }
    return null
  `;
  // Bar 6: low touches stop 99 before/with limit — must cancel, not fill.
  bars[6] = bar(6, 100.25, 100.5, 98.5, 100, 1);
  const run = runStrategyScript(bars, source, "long", {
    entryLimitExpiryBars: 2,
    forceInterpreter: true,
  });
  assert.equal(run.ok, true);
  if (!run.ok) return;
  assert.equal(run.trades.length, 0);
  assert.equal(run.markers.filter((m) => m.kind === "entry").length, 0);
  assert.equal(run.markers.filter((m) => m.kind === "signal").length, 1);
});

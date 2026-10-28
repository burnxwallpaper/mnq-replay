import assert from "node:assert/strict";
import test from "node:test";
import type { OhlcvBar } from "./strategies/types.ts";
import {
  DEFAULT_STRATEGY_SCRIPT,
  DEFAULT_SHORT_STRATEGY_SCRIPT,
  EVE_LONG_STRATEGY_SCRIPT,
  EVE_SHORT_STRATEGY_SCRIPT,
  buildLongStrategyScript,
  buildShortStrategyScript,
  isStaleDefaultScript,
  runStrategyScript,
} from "./strategy-script.ts";

function chicagoUtc(year: number, month: number, day: number, hour: number, minute: number): number {
  for (const offsetHours of [5, 6]) {
    const utc = Date.UTC(year, month - 1, day, hour + offsetHours, minute);
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utc));
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    if (
      get("year") === String(year) &&
      get("month") === String(month).padStart(2, "0") &&
      get("day") === String(day).padStart(2, "0") &&
      get("hour") === String(hour).padStart(2, "0") &&
      get("minute") === String(minute).padStart(2, "0")
    ) {
      return utc;
    }
  }
  throw new Error(`No Chicago instant for ${year}-${month}-${day} ${hour}:${minute}`);
}

function impulseSeries(signalTs: number, side: "long" | "short"): OhlcvBar[] {
  const bars: OhlcvBar[] = [];
  for (let i = 0; i < 25; i += 1) {
    const ts = signalTs - (25 - i) * 60_000;
    bars.push({ ts, o: 100, h: 100.25, l: 99.75, c: 100, v: 10 });
  }
  if (side === "long") {
    bars.push({ ts: signalTs, o: 100, h: 110, l: 100, c: 110, v: 5000 });
    bars.push({ ts: signalTs + 60_000, o: 110, h: 111, l: 109, c: 110.5, v: 10 });
  } else {
    bars.push({ ts: signalTs, o: 110, h: 110, l: 100, c: 100, v: 5000 });
    bars.push({ ts: signalTs + 60_000, o: 100, h: 101, l: 99, c: 100.25, v: 10 });
  }
  return bars;
}

function signalCount(source: string, bars: OhlcvBar[]): number {
  const run = runStrategyScript(bars, source, "test");
  assert.equal(run.ok, true, run.ok ? "" : run.error);
  return run.markers.filter((marker) => marker.kind === "signal").length;
}

test("daytime scripts stay the session default and are not treated as the eve preset", () => {
  assert.equal(DEFAULT_STRATEGY_SCRIPT.includes("PRESET=eve-2030-2359"), false);
  assert.equal(DEFAULT_SHORT_STRATEGY_SCRIPT.includes("PRESET=eve-2030-2359"), false);
  assert.match(DEFAULT_STRATEGY_SCRIPT, /PRESET=stacked-ema-hybrid/);
  assert.match(DEFAULT_SHORT_STRATEGY_SCRIPT, /PRESET=stacked-ema-hybrid/);
  assert.match(DEFAULT_STRATEGY_SCRIPT, /ema20 > ema50 && ema50 > ema100/);
  assert.match(DEFAULT_SHORT_STRATEGY_SCRIPT, /ema20 < ema50 && ema50 < ema100/);
  assert.match(DEFAULT_STRATEGY_SCRIPT, /FRIDAY_ENTRY_CUTOFF/);
  assert.match(DEFAULT_STRATEGY_SCRIPT, /ctMins >= 9 \* 60 && ctMins < 21 \* 60 - 30/);
  assert.equal(isStaleDefaultScript(DEFAULT_STRATEGY_SCRIPT), false);
  assert.equal(isStaleDefaultScript(EVE_LONG_STRATEGY_SCRIPT), false);
  assert.match(EVE_LONG_STRATEGY_SCRIPT, /ctMins >= 1230 && ctMins <= 1439/);
  assert.match(EVE_LONG_STRATEGY_SCRIPT, /body \/ span >= 0\.7/);
  assert.match(EVE_LONG_STRATEGY_SCRIPT, /body >= 6/);
  assert.match(EVE_LONG_STRATEGY_SCRIPT, /ta\.sma\(i, 20, "v"\)/);
  assert.match(EVE_LONG_STRATEGY_SCRIPT, /avgVol \* 2\.2/);
  assert.match(EVE_LONG_STRATEGY_SCRIPT, /stop: bar\.c - risk1 \* 2/);
  assert.match(EVE_LONG_STRATEGY_SCRIPT, /target: bar\.c \+ risk1 \* 2\.5/);
  assert.match(EVE_LONG_STRATEGY_SCRIPT, /risk: risk1/);
  assert.match(EVE_SHORT_STRATEGY_SCRIPT, /stop: bar\.c \+ risk1 \* 2/);
  assert.match(EVE_SHORT_STRATEGY_SCRIPT, /target: bar\.c - risk1 \* 2\.5/);
});

test("eve entries only fire from 20:30 through 23:59 Chicago", () => {
  const monday = { year: 2026, month: 10, day: 26 };
  const friday = { year: 2026, month: 10, day: 23 };
  const at = (day: typeof monday, hour: number, minute: number) =>
    chicagoUtc(day.year, day.month, day.day, hour, minute);

  assert.equal(signalCount(EVE_LONG_STRATEGY_SCRIPT, impulseSeries(at(monday, 20, 29), "long")), 0);
  assert.equal(signalCount(EVE_LONG_STRATEGY_SCRIPT, impulseSeries(at(monday, 20, 30), "long")), 1);
  assert.equal(signalCount(EVE_LONG_STRATEGY_SCRIPT, impulseSeries(at(monday, 23, 59), "long")), 1);
  assert.equal(signalCount(EVE_LONG_STRATEGY_SCRIPT, impulseSeries(at(monday, 0, 0), "long")), 0);
  assert.equal(signalCount(EVE_LONG_STRATEGY_SCRIPT, impulseSeries(at(monday, 9, 0), "long")), 0);
  assert.equal(signalCount(EVE_LONG_STRATEGY_SCRIPT, impulseSeries(at(friday, 20, 30), "long")), 1);
  assert.equal(signalCount(EVE_SHORT_STRATEGY_SCRIPT, impulseSeries(at(monday, 21, 0), "short")), 1);
  assert.equal(signalCount(EVE_SHORT_STRATEGY_SCRIPT, impulseSeries(at(monday, 9, 30), "short")), 0);

  // Daytime hybrid needs EMA100 warmup — session gate only (no signal on a 25-bar impulse stub).
  assert.equal(signalCount(buildLongStrategyScript(), impulseSeries(at(monday, 9, 0), "long")), 0);
  assert.equal(signalCount(buildLongStrategyScript(), impulseSeries(at(monday, 20, 30), "long")), 0);
  assert.match(buildLongStrategyScript(), /sessionOk/);
  assert.match(buildShortStrategyScript(), /FRIDAY_ENTRY_CUTOFF/);
});

test("eve stop is 2× risk1 while stored risk, target, and EMA→1R stay on risk1", () => {
  const ts = chicagoUtc(2026, 10, 26, 21, 15);
  const longRun = runStrategyScript(impulseSeries(ts, "long"), EVE_LONG_STRATEGY_SCRIPT, "long");
  assert.equal(longRun.ok, true, longRun.ok ? "" : longRun.error);
  assert.equal(longRun.trades.length, 1);
  const longTrade = longRun.trades[0];
  assert.ok(longTrade);
  assert.equal(longTrade.entryPrice, 110);
  assert.equal(longTrade.stopPrice, 90);
  assert.equal(longTrade.targetPrice, 135);
  assert.equal(longTrade.riskPoints, 10);

  const shortRun = runStrategyScript(impulseSeries(ts, "short"), EVE_SHORT_STRATEGY_SCRIPT, "short");
  assert.equal(shortRun.ok, true, shortRun.ok ? "" : shortRun.error);
  const shortTrade = shortRun.trades[0];
  assert.ok(shortTrade);
  assert.equal(shortTrade.entryPrice, 100);
  assert.equal(shortTrade.stopPrice, 120);
  assert.equal(shortTrade.targetPrice, 75);
  assert.equal(shortTrade.riskPoints, 10);

  // Daytime stacked-EMA hybrid ignores impulse stubs (needs EMA stack + vol); no trade expected here.
  const dayRun = runStrategyScript(impulseSeries(chicagoUtc(2026, 10, 26, 10, 0), "long"), buildLongStrategyScript(), "long");
  assert.equal(dayRun.ok, true, dayRun.ok ? "" : dayRun.error);
  assert.equal(dayRun.trades.length, 0);
});

test("explicit signal risk is what EMA→1R uses when the stop is wider", () => {
  // Extra bar after the EMA-cross close so next-bar tighten can apply (no same-bar look-ahead).
  const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 90, 90];
  const bars: OhlcvBar[] = closes.map((close, index) => ({
    ts: Date.UTC(2026, 9, 26, 15, index),
    o: close,
    h: close + 1,
    l: close - 1,
    c: close,
    v: 10,
  }));
  const withRisk = `
const ema5 = ta.ema(i, 5, "c")
if (position && position.side === "long" && bar.c < ema5) {
  return { target: position.entry + position.risk }
}
if (!position && i === 10) {
  return { signal: true, side: "long", stop: bar.c - 20, target: bar.c + 50, risk: 10 }
}
return null
`;
  const withoutRisk = withRisk.replace(", risk: 10", "");
  const widened = runStrategyScript(bars, withRisk, "wide");
  assert.equal(widened.ok, true, widened.ok ? "" : widened.error);
  assert.equal(widened.trades[0]?.riskPoints, 10);
  assert.equal(widened.trades[0]?.targetPrice, 110);
  const geometric = runStrategyScript(bars, withoutRisk, "geom");
  assert.equal(geometric.ok, true, geometric.ok ? "" : geometric.error);
  assert.equal(geometric.trades[0]?.riskPoints, 20);
  assert.equal(geometric.trades[0]?.targetPrice, 120);
});

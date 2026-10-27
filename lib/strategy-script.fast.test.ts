import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { OhlcvBar } from "./strategies/types.ts";
import {
  buildLongStrategyScript,
  buildShortStrategyScript,
  EVE_LONG_STRATEGY_SCRIPT,
  runLinkedStrategyScripts,
  runStrategyScript,
  type ScriptRun,
} from "./strategy-script.ts";

function signature(run: ScriptRun): string {
  assert.equal(run.ok, true, run.ok ? "" : run.error);
  if (!run.ok) return "";
  return JSON.stringify({ markers: run.markers, trades: run.trades });
}

function sliceBars(): OhlcvBar[] {
  const raw = JSON.parse(readFileSync("docs/data/mnq-1m-bars-2026.json", "utf8")) as Array<{
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
  }>;
  return raw.slice(100_000, 112_000).map((bar) => ({
    ts: bar.t * 1000,
    o: bar.o,
    h: bar.h,
    l: bar.l,
    c: bar.c,
    v: bar.v,
  }));
}

const bars = sliceBars();

test("generated daytime and eve legs match the interpreter on a real window", () => {
  const longSource = buildLongStrategyScript();
  const shortSource = buildShortStrategyScript();
  const fastLong = runStrategyScript(bars, longSource, "long");
  const slowLong = runStrategyScript(bars, longSource, "long", { forceInterpreter: true });
  assert.equal(signature(fastLong), signature(slowLong));

  const fastShort = runStrategyScript(bars, shortSource, "short");
  const slowShort = runStrategyScript(bars, shortSource, "short", { forceInterpreter: true });
  assert.equal(signature(fastShort), signature(slowShort));

  const fastEve = runStrategyScript(bars, EVE_LONG_STRATEGY_SCRIPT, "long");
  const slowEve = runStrategyScript(bars, EVE_LONG_STRATEGY_SCRIPT, "long", { forceInterpreter: true });
  assert.equal(signature(fastEve), signature(slowEve));

  const specs = [
    { id: "long", source: longSource },
    { id: "short", source: shortSource },
  ];
  const fastLinked = runLinkedStrategyScripts(bars, specs, { flipLockBars: 15 });
  const slowLinked = runLinkedStrategyScripts(bars, specs, {
    flipLockBars: 15,
    forceInterpreter: true,
  });
  assert.equal(fastLinked.ok, true);
  assert.equal(slowLinked.ok, true);
  assert.equal(JSON.stringify(fastLinked), JSON.stringify(slowLinked));
});

test("a script that keeps the session block but is not the builder still matches Intl", () => {
  const source = `${buildLongStrategyScript()}\n// edited\n`;
  const fast = runStrategyScript(bars, source, "long");
  const slow = runStrategyScript(bars, source, "long", { forceInterpreter: true });
  assert.equal(signature(fast), signature(slow));
});

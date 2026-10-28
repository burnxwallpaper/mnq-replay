import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OhlcvBar } from "../lib/strategies/types.ts";
import {
  defaultConfig,
  loadConfig,
  paperFlipLockBars,
  resolveFlipLockBars,
} from "./forward-state.ts";
import { DEFAULT_ENTRY_FILTERS } from "../lib/strategy-script.ts";
import { runPaperSides } from "./run-sides.ts";

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

function daytimeBars(): OhlcvBar[] {
  const start = chicagoUtc(2026, 10, 26, 10, 0);
  const bars: OhlcvBar[] = [];
  for (let i = 0; i < 50; i += 1) {
    bars.push({ ts: start + i * 60_000, o: 100, h: 100.25, l: 99.75, c: 100, v: 10 });
  }
  // Long impulse, then a bar that fills the limit and stops.
  bars[30] = { ts: bars[30].ts, o: 100, h: 110, l: 100, c: 110, v: 5000 };
  bars[31] = { ts: bars[31].ts, o: 110, h: 110.25, l: 99, c: 105, v: 10 };
  // Opposite impulse inside the 15-bar window, then one after it.
  bars[32] = { ts: bars[32].ts, o: 110, h: 110, l: 100, c: 100, v: 5000 };
  bars[47] = { ts: bars[47].ts, o: 110, h: 110, l: 100, c: 100, v: 5000 };
  return bars;
}

function signalIndexes(bars: OhlcvBar[], flipLockBars: number, side: "both" | "long" | "short" = "both") {
  const cfg = { ...defaultConfig(), side, flipLockBars, mode: "local" as const };
  const runs = runPaperSides(cfg, bars);
  const out: Record<string, number[]> = {};
  for (const item of runs) {
    assert.equal(item.run.ok, true);
    if (!item.run.ok) continue;
    out[item.id] = item.run.markers.filter((marker) => marker.kind === "signal").map((marker) => marker.barIndex);
  }
  return out;
}

test("paper daytime filters default to the web minBody of 8", () => {
  assert.deepEqual(defaultConfig().filters, DEFAULT_ENTRY_FILTERS);
  assert.equal(defaultConfig().filters.minBody, 8);
  assert.equal(defaultConfig().flipLockBars, 0);
  const example = loadConfig(join("paper", "config.example.json"));
  assert.equal(example.filters.minBody, 8);
  assert.deepEqual(example.filters, DEFAULT_ENTRY_FILTERS);
});

test("paper both sides share the web flip lock; 0 and a single side do not", () => {
  assert.equal(paperFlipLockBars({ side: "both", flipLockBars: 15 }), 15);
  assert.equal(paperFlipLockBars({ side: "both", flipLockBars: 0 }), 0);
  assert.equal(paperFlipLockBars({ side: "long", flipLockBars: 15 }), 0);

  const bars = daytimeBars();
  const locked = signalIndexes(bars, 15);
  assert.deepEqual(locked.long, [30]);
  assert.equal(locked.short.includes(32), false);
  assert.equal(locked.short.includes(47), true);

  const open = signalIndexes(bars, 0);
  assert.equal(open.short.includes(32), true);
});

test("resolveFlipLockBars prefers CLI, then env, then config, and keeps 0", () => {
  assert.equal(resolveFlipLockBars({ cli: "0", env: "8", config: 15 }), 0);
  assert.equal(resolveFlipLockBars({ cli: "  ", env: "8", config: 15 }), 8);
  assert.equal(resolveFlipLockBars({ env: "", config: 0 }), 0);
  assert.equal(resolveFlipLockBars({ config: undefined }), 0);
  assert.equal(resolveFlipLockBars({ config: "nope" }), 0);
  assert.equal(resolveFlipLockBars({ config: 15 }), 15);
});

test("loadConfig reads flipLockBars and lets FLIP_LOCK_BARS override it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mnq-paper-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ flipLockBars: 0, side: "both" }));
  const previous = process.env.FLIP_LOCK_BARS;
  delete process.env.FLIP_LOCK_BARS;
  try {
    assert.equal(loadConfig(file).flipLockBars, 0);
    process.env.FLIP_LOCK_BARS = "4";
    assert.equal(loadConfig(file).flipLockBars, 4);
  } finally {
    if (previous === undefined) delete process.env.FLIP_LOCK_BARS;
    else process.env.FLIP_LOCK_BARS = previous;
  }
});

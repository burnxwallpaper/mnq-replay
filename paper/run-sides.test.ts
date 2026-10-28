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

test("paper both sides share the web flip lock wiring; 0 and a single side do not", () => {
  assert.equal(paperFlipLockBars({ side: "both", flipLockBars: 15 }), 15);
  assert.equal(paperFlipLockBars({ side: "both", flipLockBars: 0 }), 0);
  assert.equal(paperFlipLockBars({ side: "long", flipLockBars: 15 }), 0);

  // Smoke: stacked-EMA hybrid builders run under paper both-mode without throw.
  const start = chicagoUtc(2026, 10, 26, 10, 0);
  const bars: OhlcvBar[] = [];
  for (let i = 0; i < 130; i += 1) {
    const base = 100 + i * 0.5;
    bars.push({ ts: start + i * 60_000, o: base, h: base + 0.25, l: base - 0.25, c: base, v: 10 });
  }
  const cfg = { ...defaultConfig(), side: "both" as const, flipLockBars: 15, mode: "local" as const };
  const runs = runPaperSides(cfg, bars);
  assert.deepEqual(
    runs.map((r) => r.id),
    ["long", "short"],
  );
  for (const item of runs) assert.equal(item.run.ok, true);
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

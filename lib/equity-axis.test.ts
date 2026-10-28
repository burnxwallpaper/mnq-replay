import assert from "node:assert/strict";
import test from "node:test";
import { equityAt, equityAxisTicks, equityYLabels, equityYOf } from "./equity-axis.ts";

const INNER = 628;

test("equity axis places readable UTC dates across a 90-day curve", () => {
  const t0 = Date.UTC(2026, 6, 29);
  const t1 = Date.UTC(2026, 9, 27);
  const ticks = equityAxisTicks(t0, t1, INNER);
  assert.deepEqual(
    ticks.map((tick) => tick.label),
    ["Jul 29", "Aug 20", "Sep 12", "Oct 4", "Oct 27, 2026 UTC"],
  );
  assert.equal(ticks[0]?.ts, t0);
  assert.equal(ticks[ticks.length - 1]?.ts, t1);
  assert.equal(ticks[0]?.align, "start");
  assert.equal(ticks[ticks.length - 1]?.align, "end");
  for (let index = 1; index < ticks.length; index += 1) {
    const prev = ticks[index - 1];
    const tick = ticks[index];
    assert.ok(prev && tick && tick.fraction > prev.fraction);
  }
});

test("equity axis uses clock times when the curve is shorter than two days", () => {
  const t0 = Date.UTC(2026, 9, 27, 13, 30);
  const t1 = Date.UTC(2026, 9, 27, 20, 0);
  const ticks = equityAxisTicks(t0, t1, INNER);
  assert.equal(ticks[0]?.label, "Oct 27, 13:30");
  assert.equal(ticks[ticks.length - 1]?.label, "Oct 27, 20:00 UTC");
  assert.ok(ticks.length >= 3);
  for (const tick of ticks) {
    assert.match(tick.label, /\d{2}:\d{2}/);
  }
});

test("equity axis includes the year on every tick when the range crosses a year", () => {
  const t0 = Date.UTC(2025, 10, 1);
  const t1 = Date.UTC(2026, 1, 1);
  const ticks = equityAxisTicks(t0, t1, INNER);
  assert.ok(ticks.length >= 2);
  for (const tick of ticks) {
    assert.match(tick.label, /2025|2026/);
  }
  assert.match(ticks[ticks.length - 1]?.label ?? "", /UTC$/);
});

test("equity axis keeps the first and last labels on a narrow plot", () => {
  const t0 = Date.UTC(2026, 6, 29);
  const t1 = Date.UTC(2026, 9, 27);
  const ticks = equityAxisTicks(t0, t1, 80);
  assert.deepEqual(
    ticks.map((tick) => tick.label),
    ["Jul 29", "Oct 27, 2026 UTC"],
  );
});

test("equityAt holds the previous value until the next point", () => {
  const points = [
    { ts: 1_000, equity: 10 },
    { ts: 5_000, equity: 12 },
    { ts: 9_000, equity: 8 },
  ];
  assert.equal(equityAt(points, 999), null);
  assert.equal(equityAt(points, 1_000), 10);
  assert.equal(equityAt(points, 4_999), 10);
  assert.equal(equityAt(points, 5_000), 12);
  assert.equal(equityAt(points, 10_000), 8);
  assert.equal(equityAt([], 1), null);
});

test("equityYOf puts max at padY and min at plotBottom - padY", () => {
  const padY = 10;
  const plotBottom = 148;
  assert.equal(equityYOf(100, 0, 100, padY, plotBottom), padY);
  assert.equal(equityYOf(0, 0, 100, padY, plotBottom), plotBottom - padY);
  assert.equal(equityYOf(50, 0, 100, padY, plotBottom), padY + (plotBottom - padY * 2) / 2);
});

test("equityYLabels sit on the same Y as plotted min and max", () => {
  const padY = 10;
  const plotBottom = 148;
  const min = 9_828.52;
  const max = 42_692.81;
  const labels = equityYLabels(min, max, padY, plotBottom);
  assert.equal(labels[0]?.value, max);
  assert.equal(labels[0]?.y, equityYOf(max, min, max, padY, plotBottom));
  assert.equal(labels[labels.length - 1]?.value, min);
  assert.equal(labels[labels.length - 1]?.y, equityYOf(min, min, max, padY, plotBottom));
  assert.equal(labels[0]?.y, padY);
  assert.equal(labels[labels.length - 1]?.y, plotBottom - padY);
  assert.ok(labels.length >= 2);
  assert.ok(labels.length <= 3);
});

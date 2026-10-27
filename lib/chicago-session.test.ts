import assert from "node:assert/strict";
import test from "node:test";
import { chicagoParts, dstBoundsUtc, fillSessionMasks, isDaySession, isEveSession } from "./chicago-session.ts";

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Chicago",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function intlParts(unixSec: number): { mins: number; wd: string } {
  const parts = fmt.formatToParts(new Date(unixSec * 1000));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const wd = parts.find((part) => part.type === "weekday")?.value ?? "";
  return { mins: hour * 60 + minute, wd };
}

test("Chicago wall clock matches Intl across 2021–2026, including DST weekends", () => {
  const start = Math.floor(Date.UTC(2021, 0, 1) / 1000);
  const end = Math.floor(Date.UTC(2026, 10, 3) / 1000);
  let checked = 0;
  for (let sec = start; sec < end; sec += 3600) {
    const fast = chicagoParts(sec);
    const slow = intlParts(sec);
    assert.equal(fast.mins, slow.mins, `mins at ${sec}`);
    assert.equal(fast.weekdayName, slow.wd, `weekday at ${sec}`);
    checked += 1;
  }
  for (let year = 2021; year <= 2026; year += 1) {
    const bounds = dstBoundsUtc(year);
    for (const center of [bounds.start, bounds.end]) {
      for (let sec = center - 3 * 3600; sec <= center + 3 * 3600; sec += 60) {
        const fast = chicagoParts(sec);
        const slow = intlParts(sec);
        assert.equal(fast.mins, slow.mins, `dst mins ${year} ${sec}`);
        assert.equal(fast.weekdayName, slow.wd, `dst weekday ${year} ${sec}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 50_000);
});

test("session masks follow the daytime and eve predicates", () => {
  const start = Math.floor(Date.UTC(2026, 2, 7) / 1000);
  const count = 3 * 24 * 60;
  const tsMs = new Float64Array(count);
  for (let i = 0; i < count; i += 1) tsMs[i] = (start + i * 60) * 1000;
  const day = new Uint8Array(count);
  const eve = new Uint8Array(count);
  fillSessionMasks(tsMs, day, eve);
  for (let i = 0; i < count; i += 60) {
    const parts = chicagoParts(start + i * 60);
    assert.equal(day[i] === 1, isDaySession(parts.mins, parts.weekday));
    assert.equal(eve[i] === 1, isEveSession(parts.mins));
  }
});

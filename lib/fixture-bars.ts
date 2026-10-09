export type FixtureBar = {
  symbol: "MNQ";
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

/** Shown in the UI. This series is a random walk, not a market recording. */
export const FIXTURE_NOTE =
  "Synthetic fixture. These are not real MNQ prices.";

const BAR_COUNT = 240;
const BAR_MS = 60_000;
/** Arbitrary clock. Not a traded session. */
const START_TS = Date.parse("2026-01-05T14:30:00.000Z");

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toTick(price: number) {
  return Math.round(price * 4) / 4;
}

export function buildFixtureBars(): FixtureBar[] {
  const rand = mulberry32(0x4d4e51);
  let price = 20000;
  const bars: FixtureBar[] = [];

  for (let i = 0; i < BAR_COUNT; i++) {
    const open = price;
    const close = toTick(open + (rand() - 0.48) * 18);
    const high = toTick(Math.max(open, close) + rand() * 6);
    const low = toTick(Math.min(open, close) - rand() * 6);
    bars.push({
      symbol: "MNQ",
      ts: START_TS + i * BAR_MS,
      o: toTick(open),
      h: high,
      l: low,
      c: close,
      v: Math.round(40 + rand() * 520),
    });
    price = close;
  }

  // Scripted synthetic impulse so the default strategy has one visible trade.
  // Quiet bars, then signal 25, pullback 26, limit fill 27, 2R exit 31.
  const write = (
    index: number,
    o: number,
    h: number,
    l: number,
    c: number,
    v: number,
  ) => {
    const bar = bars[index];
    bar.o = toTick(o);
    bar.h = toTick(Math.max(h, o, c));
    bar.l = toTick(Math.min(l, o, c));
    bar.c = toTick(c);
    bar.v = v;
  };
  for (let index = 0; index <= 24; index += 1) {
    const up = index % 2 === 0;
    write(index, up ? 20000 : 20001, 20001.25, 19999.75, up ? 20001 : 20000, 100);
  }
  write(25, 20000, 20020, 19998, 20018, 280);
  write(26, 20021.5, 20022, 20018.75, 20019, 70);
  write(27, 20019.25, 20019.75, 20017.5, 20018.5, 100);
  write(28, 20018.5, 20030, 20018.25, 20028, 100);
  write(29, 20028, 20040, 20026, 20038, 100);
  write(30, 20038, 20048, 20036, 20046, 100);
  write(31, 20046, 20062, 20044, 20058, 120);
  for (let index = 32; index <= 45; index += 1) {
    write(index, 20058, 20059, 20057.5, 20058.5, 90);
  }

  return bars;
}

export const FIXTURE_BARS = buildFixtureBars();

export function formatFixturePrice(price: number) {
  return price.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatFixtureClock(ts: number) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ts));
}

export function formatFixtureTime(ts: number) {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ts));
  return `${formatted} UTC`;
}

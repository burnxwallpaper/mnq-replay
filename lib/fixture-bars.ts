export type FixtureBar = {
  symbol: "MNQ";
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type RawMnqBar = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

/** Shown in the UI. */
export const FIXTURE_NOTE =
  "CME_MINI:MNQ1! 1-minute OHLCV from TradingView Premium (prodata). ~25–30 trading days.";

/** Relative to the Pages site root (works with basePath trailingSlash). */
export const MNQ_BARS_URL = "data/mnq-1m-bars.json";

export function rawToFixtureBars(raw: RawMnqBar[]): FixtureBar[] {
  return raw.map((bar) => ({
    symbol: "MNQ" as const,
    ts: bar.t * 1000,
    o: bar.o,
    h: bar.h,
    l: bar.l,
    c: bar.c,
    v: bar.v,
  }));
}

export async function loadMnqBars(): Promise<FixtureBar[]> {
  const response = await fetch(MNQ_BARS_URL);
  if (!response.ok) {
    throw new Error(`Failed to load MNQ bars (${response.status})`);
  }
  const raw = (await response.json()) as RawMnqBar[];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("MNQ bars file is empty");
  }
  return rawToFixtureBars(raw);
}

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
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ts));
  return `${formatted} UTC`;
}

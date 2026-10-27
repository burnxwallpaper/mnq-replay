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

type MnqBarsManifest = {
  format: "mnq-1m-shards-v1";
  shards: string[];
};

/** Shown in the UI. */
export const FIXTURE_NOTE =
  "MNQ continuous 1-minute OHLCV (Databento GLBX.MDP3 MNQ.FUT daily-volume front month from 2021, TradingView MNQ1! for the latest window).";

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

function isRawBarArray(value: unknown): value is RawMnqBar[] {
  return Array.isArray(value);
}

function isManifest(value: unknown): value is MnqBarsManifest {
  if (!value || typeof value !== "object") return false;
  const v = value as MnqBarsManifest;
  return v.format === "mnq-1m-shards-v1" && Array.isArray(v.shards);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load MNQ bars from ${url} (${response.status})`);
  }
  return response.json();
}

export async function loadMnqBars(): Promise<FixtureBar[]> {
  const payload = await fetchJson(MNQ_BARS_URL);
  let raw: RawMnqBar[];
  if (isRawBarArray(payload)) {
    raw = payload;
  } else if (isManifest(payload)) {
    const parts = await Promise.all(payload.shards.map((shard) => fetchJson(shard)));
    raw = [];
    for (const part of parts) {
      if (!isRawBarArray(part) || part.length === 0) {
        throw new Error("MNQ bars shard is empty or invalid");
      }
      raw.push(...part);
    }
  } else {
    throw new Error("MNQ bars file is empty");
  }
  if (raw.length === 0) {
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

import { readPackCache, writePackCache } from "@/lib/bar-cache";

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

/** Last this many seconds of history is the default page load. */
export const RECENT_WINDOW_SEC = 90 * 24 * 60 * 60;

export type HistoryPack = {
  id: string;
  url: string;
  label: string;
  from: number;
  to: number;
  bars: number;
  /** Other pack ids concatenated in order. `url` is ignored. */
  parts?: string[];
  /** After parsing `url`, keep only the last RECENT_WINDOW_SEC. */
  sliceRecent?: boolean;
};

export type HistoryCatalog = {
  format: "mnq-1m-pack-v1";
  defaultPack: string;
  packs: HistoryPack[];
};

export type LoadedHistory = {
  bars: FixtureBar[];
  packId: string;
  label: string;
};

type ShardManifest = {
  format: "mnq-1m-shards-v1";
  shards: string[];
};

/** Shown in the UI. */
export const FIXTURE_NOTE =
  "MNQ continuous 1-minute OHLCV (Databento GLBX.MDP3 MNQ.FUT daily-volume front month from 2021, TradingView MNQ1! for the latest window).";

/** Relative to the Pages site root (works with basePath trailingSlash). */
export const MNQ_BARS_URL = "data/mnq-1m-bars.json";

const HISTORY_PACK_KEY = "mnq-replay.historyPack";

let monolithCache: RawMnqBar[] | null = null;

export function rawToFixtureBars(raw: RawMnqBar[]): FixtureBar[] {
  const out: FixtureBar[] = [];
  for (const bar of raw) {
    out.push({
      symbol: "MNQ",
      ts: bar.t * 1000,
      o: bar.o,
      h: bar.h,
      l: bar.l,
      c: bar.c,
      v: bar.v,
    });
  }
  return out;
}

export function sliceRecentRaw(raw: RawMnqBar[], windowSec = RECENT_WINDOW_SEC): RawMnqBar[] {
  if (raw.length === 0) return raw;
  const last = raw[raw.length - 1];
  if (!last) return raw;
  const cutoff = last.t - windowSec;
  let lo = 0;
  let hi = raw.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const bar = raw[mid];
    if (!bar || bar.t < cutoff) lo = mid + 1;
    else hi = mid;
  }
  return raw.slice(lo);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRawBar(value: unknown): RawMnqBar | null {
  if (!isRecord(value)) return null;
  const t = readNumber(value.t);
  const o = readNumber(value.o);
  const h = readNumber(value.h);
  const l = readNumber(value.l);
  const c = readNumber(value.c);
  const v = readNumber(value.v);
  if (t === null || o === null || h === null || l === null || c === null || v === null) return null;
  return { t, o, h, l, c, v };
}

function isRawBarArray(value: unknown): value is RawMnqBar[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return readRawBar(value[0]) !== null && readRawBar(value[value.length - 1]) !== null;
}

function readStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

function readPack(value: unknown): HistoryPack | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.url !== "string" || typeof value.label !== "string") {
    return null;
  }
  const from = readNumber(value.from);
  const to = readNumber(value.to);
  const bars = readNumber(value.bars);
  if (from === null || to === null || bars === null) return null;
  const pack: HistoryPack = {
    id: value.id,
    url: value.url,
    label: value.label,
    from,
    to,
    bars,
  };
  const parts = readStringList(value.parts);
  if (parts && parts.length > 0) pack.parts = parts;
  if (value.sliceRecent === true) pack.sliceRecent = true;
  return pack;
}

export function historyCatalogFromUnknown(value: unknown): HistoryCatalog | null {
  if (!isRecord(value) || value.format !== "mnq-1m-pack-v1") return null;
  if (typeof value.defaultPack !== "string" || !Array.isArray(value.packs)) return null;
  const packs: HistoryPack[] = [];
  for (const item of value.packs) {
    const pack = readPack(item);
    if (!pack) return null;
    packs.push(pack);
  }
  if (packs.length === 0 || !packs.some((pack) => pack.id === value.defaultPack)) return null;
  return { format: "mnq-1m-pack-v1", defaultPack: value.defaultPack, packs };
}

function isShardManifest(value: unknown): value is ShardManifest {
  if (!isRecord(value)) return false;
  if (value.format !== "mnq-1m-shards-v1") return false;
  const shards = readStringList(value.shards);
  return shards !== null && shards.length > 0;
}

function catalogFromShards(shards: string[]): HistoryCatalog {
  const years: HistoryPack[] = shards.map((url) => {
    const yearMatch = url.match(/(\d{4})/);
    const year = yearMatch?.[1] ?? url;
    return { id: year, url, label: year, from: 0, to: 0, bars: 0 };
  });
  const last = years[years.length - 1];
  const packs: HistoryPack[] = [];
  if (last) {
    packs.push({
      id: "recent",
      url: last.url,
      label: "Last 90 days",
      from: 0,
      to: 0,
      bars: 0,
      sliceRecent: true,
    });
  }
  packs.push(...years);
  packs.push({
    id: "full",
    url: "",
    label: "Full history",
    from: years[0]?.from ?? 0,
    to: last?.to ?? 0,
    bars: 0,
    parts: years.map((pack) => pack.id),
  });
  return { format: "mnq-1m-pack-v1", defaultPack: "recent", packs };
}

function catalogFromMonolith(raw: RawMnqBar[]): HistoryCatalog {
  const first = raw[0];
  const last = raw[raw.length - 1];
  const recent = sliceRecentRaw(raw);
  return {
    format: "mnq-1m-pack-v1",
    defaultPack: "recent",
    packs: [
      {
        id: "recent",
        url: "",
        label: "Last 90 days",
        from: recent[0]?.t ?? 0,
        to: recent[recent.length - 1]?.t ?? 0,
        bars: recent.length,
      },
      {
        id: "full",
        url: "",
        label: "Full history",
        from: first?.t ?? 0,
        to: last?.t ?? 0,
        bars: raw.length,
      },
    ],
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load MNQ bars from ${url} (${response.status})`);
  }
  return response.json();
}

function cacheKey(pack: HistoryPack): string | null {
  if (!pack.url || pack.bars <= 0) return null;
  return `${pack.url}|${pack.bars}|${pack.from}|${pack.to}`;
}

async function fetchPackText(pack: HistoryPack): Promise<string> {
  const key = cacheKey(pack);
  if (key) {
    const cached = await readPackCache(key);
    if (cached !== null) return cached;
  }
  const response = await fetch(pack.url);
  if (!response.ok) {
    throw new Error(`Failed to load MNQ bars from ${pack.url} (${response.status})`);
  }
  const text = await response.text();
  if (key) void writePackCache(key, text);
  return text;
}

function parseRawText(text: string): RawMnqBar[] {
  const payload: unknown = JSON.parse(text);
  if (!isRawBarArray(payload)) throw new Error("MNQ bars shard is empty or invalid");
  return payload;
}

function appendPart(into: RawMnqBar[], part: RawMnqBar[]) {
  let start = 0;
  const last = into[into.length - 1];
  if (last) {
    while (start < part.length) {
      const bar = part[start];
      if (!bar || bar.t > last.t) break;
      start += 1;
    }
  }
  for (let i = start; i < part.length; i += 1) {
    const bar = part[i];
    if (bar) into.push(bar);
  }
}

export function readStoredHistoryPack(): string | null {
  try {
    return window.localStorage.getItem(HISTORY_PACK_KEY);
  } catch {
    return null;
  }
}

export function writeStoredHistoryPack(packId: string) {
  try {
    window.localStorage.setItem(HISTORY_PACK_KEY, packId);
  } catch {
    // Ignore private-mode storage failures.
  }
}

export async function fetchHistoryCatalog(): Promise<HistoryCatalog> {
  const payload = await fetchJson(MNQ_BARS_URL);
  const catalog = historyCatalogFromUnknown(payload);
  if (catalog) return catalog;
  if (isShardManifest(payload)) return catalogFromShards(payload.shards);
  if (isRawBarArray(payload)) {
    monolithCache = payload;
    return catalogFromMonolith(payload);
  }
  throw new Error("MNQ bars file is empty");
}

export async function loadHistoryPack(
  catalog: HistoryCatalog,
  packId: string,
  onProgress?: (message: string) => void,
): Promise<LoadedHistory> {
  const pack = catalog.packs.find((item) => item.id === packId) ?? catalog.packs[0];
  if (!pack) throw new Error("MNQ history catalog is empty");

  if (monolithCache && (pack.id === "recent" || pack.id === "full") && pack.url === "") {
    const raw = pack.id === "recent" ? sliceRecentRaw(monolithCache) : monolithCache;
    return { bars: rawToFixtureBars(raw), packId: pack.id, label: pack.label };
  }

  const partIds = pack.parts && pack.parts.length > 0 ? pack.parts : [pack.id];
  const combined: RawMnqBar[] = [];
  for (let index = 0; index < partIds.length; index += 1) {
    const partId = partIds[index];
    const part = catalog.packs.find((item) => item.id === partId);
    if (!part || !part.url) throw new Error("MNQ history pack is missing a file");
    onProgress?.(`Loading ${part.label} (${index + 1}/${partIds.length})…`);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    const raw = parseRawText(await fetchPackText(part));
    appendPart(combined, part.sliceRecent ? sliceRecentRaw(raw) : raw);
  }
  if (combined.length === 0) throw new Error("MNQ bars file is empty");
  return { bars: rawToFixtureBars(combined), packId: pack.id, label: pack.label };
}

export async function loadMnqBars(): Promise<FixtureBar[]> {
  const catalog = await fetchHistoryCatalog();
  const loaded = await loadHistoryPack(catalog, catalog.defaultPack);
  return loaded.bars;
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

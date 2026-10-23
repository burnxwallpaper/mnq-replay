/**
 * Shared types + I/O for local forward paper (virtual book).
 * state.json / trades.jsonl / config.json are gitignored.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_ENTRY_FILTERS,
  DEFAULT_ROUND_TRIP_FEE_USD,
  MNQ_POINT_VALUE,
  STARTING_NET_ASSET,
  normalizeEntryFilters,
  normalizeRoundTripFee,
  type EntryFilters,
} from "../lib/strategy-script.ts";

export const PAPER_DIR = resolve(import.meta.dirname);
export const CONFIG_PATH = resolve(PAPER_DIR, "config.json");
export const CONFIG_EXAMPLE_PATH = resolve(PAPER_DIR, "config.example.json");
export const STATE_PATH = resolve(PAPER_DIR, "state.json");
export const TRADES_PATH = resolve(PAPER_DIR, "trades.jsonl");
export const BARS_PATH = resolve(PAPER_DIR, "../public/data/mnq-1m-bars.json");

export type PaperMode = "local" | "ib-paper";
export type PaperSide = "long" | "short" | "both";

export type PaperConfig = {
  mode: PaperMode;
  ibHost: string;
  ibPort: number;
  clientId: number;
  allowLive: boolean;
  symbol: string;
  exchange: string;
  currency: string;
  filters: EntryFilters;
  roundTripFeeUsd: number;
  pointValue: number;
  startingEquity: number;
  /** Soft cap note; local runners size 1 contract per fill (match backtest). */
  maxContracts: number;
  side: PaperSide;
};

export type OpenVirtualPosition = {
  strategyId: string;
  side: "long" | "short";
  entryTs: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  riskPoints: number;
  contracts: number;
};

export type ClosedPaperTrade = {
  strategyId: string;
  side: "long" | "short";
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: "stop" | "target";
  riskPoints: number;
  points: number;
  pnlUsd: number;
  feeUsd: number;
  contracts: number;
};

export type PaperState = {
  version: 1;
  startedAt: string;
  updatedAt: string;
  lastProcessedBarTs: number | null;
  equity: number;
  peakEquity: number;
  totalFees: number;
  closedTradeCount: number;
  openPositions: OpenVirtualPosition[];
  configSnapshot: Pick<
    PaperConfig,
    "filters" | "roundTripFeeUsd" | "pointValue" | "startingEquity" | "side" | "maxContracts"
  >;
};

const LIVE_PORTS = new Set([7496]);

export function defaultConfig(): PaperConfig {
  return {
    mode: "local",
    ibHost: "127.0.0.1",
    ibPort: 7497,
    clientId: 7,
    allowLive: false,
    symbol: "MNQ",
    exchange: "GLOBEX",
    currency: "USD",
    filters: { ...DEFAULT_ENTRY_FILTERS },
    roundTripFeeUsd: DEFAULT_ROUND_TRIP_FEE_USD,
    pointValue: MNQ_POINT_VALUE,
    startingEquity: STARTING_NET_ASSET,
    maxContracts: 1,
    side: "both",
  };
}

export function loadConfig(path = CONFIG_PATH): PaperConfig {
  const file = existsSync(path)
    ? path
    : existsSync(CONFIG_EXAMPLE_PATH)
      ? CONFIG_EXAMPLE_PATH
      : null;
  if (!file) return defaultConfig();
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PaperConfig>;
  const base = defaultConfig();
  const mode = raw.mode === "ib-paper" ? "ib-paper" : "local";
  const side: PaperSide =
    raw.side === "long" || raw.side === "short" || raw.side === "both" ? raw.side : "both";
  const cfg: PaperConfig = {
    ...base,
    ...raw,
    mode,
    side,
    filters: normalizeEntryFilters(raw.filters ?? base.filters),
    roundTripFeeUsd: normalizeRoundTripFee(raw.roundTripFeeUsd ?? base.roundTripFeeUsd),
    pointValue:
      typeof raw.pointValue === "number" && Number.isFinite(raw.pointValue) && raw.pointValue > 0
        ? raw.pointValue
        : base.pointValue,
    startingEquity:
      typeof raw.startingEquity === "number" && Number.isFinite(raw.startingEquity)
        ? raw.startingEquity
        : base.startingEquity,
    maxContracts:
      typeof raw.maxContracts === "number" && raw.maxContracts >= 1
        ? Math.floor(raw.maxContracts)
        : 1,
    ibPort: typeof raw.ibPort === "number" ? raw.ibPort : base.ibPort,
    clientId: typeof raw.clientId === "number" ? raw.clientId : base.clientId,
    allowLive: raw.allowLive === true,
    ibHost: typeof raw.ibHost === "string" ? raw.ibHost : base.ibHost,
  };
  return cfg;
}

/** Refuse live IB ports unless allowLive is explicitly true. */
export function assertPaperSafe(cfg: PaperConfig): void {
  const liveLike =
    cfg.mode !== "local" &&
    (LIVE_PORTS.has(cfg.ibPort) || String(cfg.mode).toLowerCase().includes("live"));
  if (liveLike && !cfg.allowLive) {
    throw new Error(
      `Refusing to start: ibPort=${cfg.ibPort} / mode=${cfg.mode} looks like LIVE. ` +
        `Use paper port 7497 (check Gateway settings) and keep allowLive=false. ` +
        `Only set "allowLive": true in config.json if you intentionally accept live risk.`,
    );
  }
}

export function emptyState(cfg: PaperConfig): PaperState {
  const now = new Date().toISOString();
  return {
    version: 1,
    startedAt: now,
    updatedAt: now,
    lastProcessedBarTs: null,
    equity: cfg.startingEquity,
    peakEquity: cfg.startingEquity,
    totalFees: 0,
    closedTradeCount: 0,
    openPositions: [],
    configSnapshot: {
      filters: cfg.filters,
      roundTripFeeUsd: cfg.roundTripFeeUsd,
      pointValue: cfg.pointValue,
      startingEquity: cfg.startingEquity,
      side: cfg.side,
      maxContracts: cfg.maxContracts,
    },
  };
}

export function loadState(cfg: PaperConfig): PaperState {
  if (!existsSync(STATE_PATH)) return emptyState(cfg);
  const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as PaperState;
  return {
    ...emptyState(cfg),
    ...raw,
    openPositions: Array.isArray(raw.openPositions) ? raw.openPositions : [],
  };
}

export function saveState(state: PaperState): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function appendTrade(trade: ClosedPaperTrade): void {
  mkdirSync(dirname(TRADES_PATH), { recursive: true });
  appendFileSync(TRADES_PATH, JSON.stringify(trade) + "\n", "utf8");
}

export type RawBar = { t: number; o: number; h: number; l: number; c: number; v: number };

export function loadBars() {
  const raw = JSON.parse(readFileSync(BARS_PATH, "utf8")) as RawBar[];
  return raw.map((b) => ({
    ts: b.t * 1000,
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
  }));
}

export function tradePoints(
  side: "long" | "short",
  entry: number,
  exit: number,
): number {
  return side === "long" ? exit - entry : entry - exit;
}

export function formatMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

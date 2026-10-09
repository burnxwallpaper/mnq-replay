export type OhlcvBar = {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type ImpulsePullbackLongParams = {
  lookback: number;
  minBodyRatio: number;
  minBodyMultiple: number;
  minVolumeMultiple: number;
  maxPullbackVolumeMultiple: number;
  minClosePositionInSignalRange: number;
  maxPullbackBars: number;
  rewardMultiple: number;
  limitExpiryBars: number;
  pointValue: number;
  quantity: number;
};

export type StrategyConfig = {
  id: string;
  name: string;
  enabled: boolean;
  type: "impulse_pullback_long";
  timeframe: "1m";
  params: ImpulsePullbackLongParams;
};

export type MarkerKind = "signal" | "entry" | "exit";

export type ChartMarker = {
  strategyId: string;
  barIndex: number;
  /** Cursor index at which this marker is allowed to appear. */
  visibleFromIndex: number;
  kind: MarkerKind;
  win: boolean | null;
  /** Fill price for an entry or exit arrow. */
  price?: number;
  side?: "long" | "short";
};

export type Trade = {
  strategyId: string;
  signalIndex: number;
  confirmIndex: number;
  entryIndex: number;
  exitIndex: number | null;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  exitPrice: number | null;
  exitReason: "stop" | "target" | null;
  riskPoints: number;
  pointValue: number;
  quantity: number;
};

export type StrategyRun = {
  config: StrategyConfig;
  trades: Trade[];
  markers: ChartMarker[];
};

export type StrategyScore = {
  id: string;
  name: string;
  realizedR: number;
  realizedPnl: number;
  openR: number;
  openPnl: number;
  totalR: number;
  totalPnl: number;
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
};

export type BookSnapshot = {
  strategies: StrategyScore[];
  realizedR: number;
  realizedPnl: number;
  openR: number;
  openPnl: number;
  totalR: number;
  totalPnl: number;
};

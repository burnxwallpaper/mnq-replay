export type DatasetStatus = "empty" | "ready" | "error";

export type DatasetReport = {
  status: DatasetStatus;
  symbol: "MNQ";
  timeframe: "1m";
  databasePath: string;
  /** MNQ rows in the bars table. Null when the store cannot be counted. */
  barCount: number | null;
  message: string;
};

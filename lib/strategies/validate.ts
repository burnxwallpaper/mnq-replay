import type {
  ImpulsePullbackLongParams,
  StrategyConfig,
} from "./types";

export const PARAM_KEYS = [
  "lookback",
  "minBodyRatio",
  "minBodyMultiple",
  "minVolumeMultiple",
  "maxPullbackVolumeMultiple",
  "minClosePositionInSignalRange",
  "maxPullbackBars",
  "rewardMultiple",
  "limitExpiryBars",
  "pointValue",
  "quantity",
] as const;

const ROOT_KEYS = ["id", "name", "enabled", "type", "timeframe", "params"] as const;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], label: string) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`${label} has unknown field ${key}.`);
    }
  }
}

function finiteNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Param ${key} must be a finite number.`);
  }
  return value;
}

function positiveInteger(value: number, key: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Param ${key} must be an integer of at least 1.`);
  }
}

export function validateStrategyConfig(value: unknown): StrategyConfig {
  const record = asRecord(value, "Strategy config");
  rejectUnknown(record, ROOT_KEYS, "Strategy config");

  if (typeof record.id !== "string" || record.id.trim() === "") {
    throw new Error("Strategy id is required.");
  }
  if (typeof record.name !== "string" || record.name.trim() === "") {
    throw new Error("Strategy name is required.");
  }
  if (typeof record.enabled !== "boolean") {
    throw new Error("Strategy enabled must be a boolean.");
  }
  if (record.type !== "impulse_pullback_long") {
    throw new Error(`Unsupported strategy type: ${String(record.type)}.`);
  }
  if (record.timeframe !== "1m") {
    throw new Error("Strategy timeframe must be 1m.");
  }

  const paramsRecord = asRecord(record.params, "Strategy params");
  rejectUnknown(paramsRecord, PARAM_KEYS, "Strategy params");
  const numeric = Object.fromEntries(
    PARAM_KEYS.map((key) => [key, finiteNumber(paramsRecord, key)]),
  ) as ImpulsePullbackLongParams;

  positiveInteger(numeric.lookback, "lookback");
  positiveInteger(numeric.maxPullbackBars, "maxPullbackBars");
  positiveInteger(numeric.limitExpiryBars, "limitExpiryBars");
  if (numeric.minBodyRatio <= 0 || numeric.minBodyRatio > 1) {
    throw new Error("Param minBodyRatio must be in the range (0, 1].");
  }
  if (numeric.minBodyMultiple <= 0) {
    throw new Error("Param minBodyMultiple must be greater than 0.");
  }
  if (numeric.minVolumeMultiple <= 0) {
    throw new Error("Param minVolumeMultiple must be greater than 0.");
  }
  if (numeric.maxPullbackVolumeMultiple < 0) {
    throw new Error("Param maxPullbackVolumeMultiple must be at least 0.");
  }
  if (
    numeric.minClosePositionInSignalRange < 0 ||
    numeric.minClosePositionInSignalRange > 1
  ) {
    throw new Error("Param minClosePositionInSignalRange must be from 0 to 1.");
  }
  if (numeric.rewardMultiple <= 0) {
    throw new Error("Param rewardMultiple must be greater than 0.");
  }
  if (numeric.pointValue <= 0) {
    throw new Error("Param pointValue must be greater than 0.");
  }
  if (numeric.quantity <= 0) {
    throw new Error("Param quantity must be greater than 0.");
  }

  return {
    id: record.id,
    name: record.name,
    enabled: record.enabled,
    type: "impulse_pullback_long",
    timeframe: "1m",
    params: numeric,
  };
}

export function assertUniqueIds(configs: StrategyConfig[]) {
  const seen = new Set<string>();
  for (const config of configs) {
    if (seen.has(config.id)) {
      throw new Error(`Duplicate strategy id: ${config.id}.`);
    }
    seen.add(config.id);
  }
}

import fs from "node:fs";
import path from "node:path";
import type { StrategyConfig } from "./types";
import { assertUniqueIds, validateStrategyConfig } from "./validate";

export function loadStrategyConfigs(
  directory = path.join(process.cwd(), "strategies"),
): StrategyConfig[] {
  const files = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== "schema.json")
    .sort();
  const configs = files.map((name) => {
    const raw: unknown = JSON.parse(
      fs.readFileSync(path.join(directory, name), "utf8"),
    );
    return validateStrategyConfig(raw);
  });
  assertUniqueIds(configs);
  return configs;
}

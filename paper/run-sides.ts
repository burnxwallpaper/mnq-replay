/**
 * Daytime paper books. Long and short share one flip lock by calling
 * `runLinkedStrategyScripts` — the same helper the replay page uses.
 * A single side does not lock, matching the web (the lock applies only when both run).
 */
import type { OhlcvBar } from "../lib/strategies/types.ts";
import {
  buildLongStrategyScript,
  buildShortStrategyScript,
  runLinkedStrategyScripts,
  runStrategyScript,
  type ScriptRun,
} from "../lib/strategy-script.ts";
import { paperFlipLockBars, type PaperConfig } from "./forward-state.ts";

export type PaperSideRun = { id: string; run: ScriptRun };

export function runPaperSides(cfg: PaperConfig, bars: OhlcvBar[]): PaperSideRun[] {
  const expiry = cfg.entryLimitExpiryBars;
  if (cfg.side === "both") {
    const linked = runLinkedStrategyScripts(
      bars,
      [
        { id: "long", source: buildLongStrategyScript(cfg.filters) },
        { id: "short", source: buildShortStrategyScript(cfg.filters) },
      ],
      { flipLockBars: paperFlipLockBars(cfg), entryLimitExpiryBars: expiry },
    );
    if (!linked.ok) throw new Error(linked.error);
    return linked.runs;
  }

  const runs: PaperSideRun[] = [];
  if (cfg.side === "long") {
    const run = runStrategyScript(bars, buildLongStrategyScript(cfg.filters), "long", {
      entryLimitExpiryBars: expiry,
    });
    if (!run.ok) throw new Error(`Long script failed: ${run.error}`);
    runs.push({ id: "long", run });
  }
  if (cfg.side === "short") {
    const run = runStrategyScript(bars, buildShortStrategyScript(cfg.filters), "short", {
      entryLimitExpiryBars: expiry,
    });
    if (!run.ok) throw new Error(`Short script failed: ${run.error}`);
    runs.push({ id: "short", run });
  }
  return runs;
}

/**
 * IBKR paper stub (TypeScript).
 *
 * This does NOT place orders. It only loads config, enforces paper-port safety,
 * and prints the next steps for a real Gateway loop.
 *
 * Optional later: connect with `@stoqey/ib` once IB Gateway is logged into Paper
 * on port 4002. Prefer the Python loop (`ib_paper_loop.py` + ib_insync).
 *
 * Usage: npx tsx paper/ib-paper-runner.ts
 */
import { assertPaperSafe, loadConfig } from "./forward-state.ts";

function main() {
  const cfg = loadConfig();

  if (cfg.mode === "local") {
    console.log(
      'config.mode is "local". Set "mode": "ib-paper" in paper/config.json when you are ready to talk to Gateway.',
    );
  }

  // Safety: refuse live-looking ports unless allowLive is explicitly true.
  assertPaperSafe(cfg);

  console.log("=== IBKR paper stub (no orders) ===");
  console.log(`Host: ${cfg.ibHost}:${cfg.ibPort}  clientId=${cfg.clientId}`);
  console.log(`Contract intent: FUT ${cfg.symbol} ${cfg.exchange} ${cfg.currency}`);
  console.log(
    `Filters: ${cfg.filters.bodyRatio}/${cfg.filters.minBody}/${cfg.filters.volLen}/${cfg.filters.volMult}`,
  );
  console.log(`Side: ${cfg.side} | maxContracts: ${cfg.maxContracts} (soft cap; live size TBD)`);
  console.log(
    `Flip lock bars: ${cfg.flipLockBars} (effective ${cfg.side === "both" ? cfg.flipLockBars : 0}; 0 = off; shared when side=both)`,
  );
  console.log("");
  console.log("Paper only. Gateway Paper port is 4002. Do not use live ports 4001 or 7496.");
  console.log("  1. Copy config.example.json → config.json (mode ib-paper, port 4002).");
  console.log("  2. Connection smoke:  py -3 paper/ib_paper_stub.py --port 4002");
  console.log("  3. Dry-run (no orders): py -3 paper/ib_paper_loop.py --dry-run --host 127.0.0.1 --port 4002");
  console.log("  4. Paper orders:        py -3 paper/ib_paper_loop.py --place-orders --host 127.0.0.1 --port 4002");
  console.log("Daytime session CT 09:00–20:29, Fri no new entries from 14:45, last 30m blocked,");
  console.log("2.5R / EMA→1R, entry limit expires after 2 completed 1m bars, flip lock default 0 (off).");
  console.log("NEVER point this at live port 7496 or 4001.");
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

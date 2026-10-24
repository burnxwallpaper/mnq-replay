/**
 * IBKR paper stub (TypeScript).
 *
 * This does NOT place orders. It only loads config, enforces paper-port safety,
 * and prints the next steps for a real Gateway loop.
 *
 * Optional later: connect with `@stoqey/ib` once IB Gateway is logged into Paper
 * on port 7497. Prefer the Python stub (`ib_paper_stub.py` + ib_insync) for a
 * quicker first connection test.
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
  console.log("");
  console.log("TODO — when IB Gateway Paper is running:");
  console.log("  1. Copy config.example.json → config.json, set mode to \"ib-paper\", port 7497.");
  console.log("  2. Prefer Python smoke test:  python paper/ib_paper_stub.py");
  console.log("     (pip install ib_insync). It qualifies MNQ and prints account + contract.");
  console.log("  3. Next step (not in this scaffold): 1m bar loop → signal → bracket orders");
  console.log("     matching session America/Chicago 09:00–20:29 (no new entries last 30m before 21:00 close; Fri no new entries from 14:45 CT), 2R / 1R EMA tighten, fee tracking.");
  console.log("");
  console.log("Refusing to auto-install @stoqey/ib here — add it yourself when ready.");
  console.log("NEVER point this at live port 7496 until you explicitly set allowLive: true.");
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

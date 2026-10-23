#!/usr/bin/env python3
"""
IBKR Paper Trading smoke test (optional).

Prereqs:
  1. IBKR Account Management → Paper Trading enabled (same login family as live HK).
  2. IB Gateway (or TWS) logged into **Paper**, API enabled.
  3. API socket port usually **7497** for paper (7496 live) — confirm in Gateway settings.
  4. pip install ib_insync

Usage:
  python paper/ib_paper_stub.py
  python paper/ib_paper_stub.py --port 7497 --host 127.0.0.1 --client-id 7

This script connects, prints managed accounts, qualifies MNQ on GLOBEX, and exits.
It does **not** place orders. Next step is a signal loop wired to the TypeScript strategy.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

LIVE_PORTS = {7496}
DEFAULT_PORT = 7497


def load_config() -> dict:
    paper_dir = Path(__file__).resolve().parent
    for name in ("config.json", "config.example.json"):
        path = paper_dir / name
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    return {}


def main() -> int:
    cfg = load_config()
    parser = argparse.ArgumentParser(description="IBKR paper connection smoke test")
    parser.add_argument("--host", default=cfg.get("ibHost", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(cfg.get("ibPort", DEFAULT_PORT)))
    parser.add_argument("--client-id", type=int, default=int(cfg.get("clientId", 7)))
    parser.add_argument(
        "--allow-live",
        action="store_true",
        default=bool(cfg.get("allowLive", False)),
        help="Required if port looks like live (7496).",
    )
    parser.add_argument("--symbol", default=cfg.get("symbol", "MNQ"))
    parser.add_argument("--exchange", default=cfg.get("exchange", "GLOBEX"))
    parser.add_argument("--currency", default=cfg.get("currency", "USD"))
    args = parser.parse_args()

    if args.port in LIVE_PORTS and not args.allow_live:
        print(
            f"Refusing port {args.port} (live-looking). Use paper 7497, or pass --allow-live.",
            file=sys.stderr,
        )
        return 2

    try:
        from ib_insync import IB, Future  # type: ignore
    except ImportError:
        print("ib_insync not installed. Run:  pip install ib_insync", file=sys.stderr)
        return 1

    ib = IB()
    print(f"Connecting to {args.host}:{args.port} clientId={args.client_id} ...")
    try:
        ib.connect(args.host, args.port, clientId=args.client_id, readonly=True)
    except Exception as exc:  # noqa: BLE001
        print(f"Connect failed: {exc}", file=sys.stderr)
        print(
            "Is IB Gateway / TWS running, logged into Paper, API enabled, and the port matching?",
            file=sys.stderr,
        )
        return 1

    try:
        accounts = ib.managedAccounts()
        print(f"Managed accounts: {accounts}")
        # Continuous / front-month: leave lastTradeDateOrContractMonth empty and let IB pick.
        contract = Future(
            symbol=args.symbol,
            lastTradeDateOrContractMonth="",
            exchange=args.exchange,
            currency=args.currency,
        )
        details = ib.reqContractDetails(contract)
        if not details:
            print("No contract details returned for MNQ — check market data / permissions.")
        else:
            # Prefer the front month by sorting expiry ascending.
            details_sorted = sorted(
                details,
                key=lambda d: d.contract.lastTradeDateOrContractMonth or "",
            )
            front = details_sorted[0].contract
            print(
                f"Front-ish MNQ: conId={front.conId} localSymbol={front.localSymbol} "
                f"expiry={front.lastTradeDateOrContractMonth} exchange={front.exchange}"
            )
            if len(details_sorted) > 1:
                print(f"(+{len(details_sorted) - 1} other expiries available — plan rollover)")
        print()
        print("Smoke test OK. Next step: wire 1m bars → impulse signals → bracket orders.")
        print("Keep using Paper until you are satisfied; never switch port to 7496 casually.")
        return 0
    finally:
        ib.disconnect()


if __name__ == "__main__":
    raise SystemExit(main())

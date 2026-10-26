#!/usr/bin/env python3
"""Flip-lock parity with lib/strategy-script.ts, plus the IB loop's single-position book."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

PAPER = Path(__file__).resolve().parent
ROOT = PAPER.parent
if str(PAPER) not in sys.path:
    sys.path.insert(0, str(PAPER))

import flip_lock  # noqa: E402
import ib_paper_loop as loop  # noqa: E402


def _bar(ts: int, o: float, h: float, l: float, c: float, v: float = 10) -> loop.Bar:
    return loop.Bar(ts=ts, o=o, h=h, l=l, c=c, v=v)


class OracleParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        proc = subprocess.run(
            ["node", "--import", "tsx", "paper/flip-lock-oracle.ts"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            raise AssertionError(f"flip-lock oracle failed\n{proc.stderr}\n{proc.stdout}")
        cls.oracle = json.loads(proc.stdout)

    def test_default_and_normalize_match_the_web_helper(self) -> None:
        self.assertEqual(self.oracle["defaultFlipLockBars"], flip_lock.DEFAULT_FLIP_LOCK_BARS)
        for item in self.oracle["normalize"]:
            fallback = flip_lock.DEFAULT_FLIP_LOCK_BARS if item["fallback"] is None else int(item["fallback"])
            got = flip_lock.normalize_flip_lock_bars(item["raw"], fallback)
            self.assertEqual(got, item["value"], item)

    def test_lock_steps_match_note_stop_and_is_opposite(self) -> None:
        for case in self.oracle["locks"]:
            locks: list[flip_lock.IndexFlipLock] = []
            for step in case["steps"]:
                if "note" in step:
                    note = step["note"]
                    flip_lock.note_stop_flip_lock(
                        locks,
                        case["flipLockBars"],
                        note["exitIndex"],
                        note["stopSide"],
                        note["reason"],
                    )
                    self.assertEqual(
                        [(item.from_bar, item.until_bar, item.stop_side) for item in locks],
                        [(item["fromBar"], item["untilBar"], item["stopSide"]) for item in step["locks"]],
                        case["name"],
                    )
                else:
                    check = step["check"]
                    got = flip_lock.is_opposite_flip_locked(locks, check["side"], check["signalIndex"])
                    self.assertEqual(got, step["locked"], (case["name"], check))

    def test_fills_match_the_web_helper(self) -> None:
        raw = json.loads((PAPER / "flip-lock-cases.json").read_text(encoding="utf-8"))
        by_name = {item["name"]: item for item in raw["fills"]}
        for item in self.oracle["fills"]:
            spec = by_name[item["name"]]
            bar = _bar(0, spec["bar"]["o"], spec["bar"]["h"], spec["bar"]["l"], spec["bar"]["c"])
            if item["kind"] == "exit":
                got = flip_lock.resolve_exit_fill(bar, spec["side"], spec["stop"], spec["target"])
                if item["price"] is None:
                    self.assertIsNone(got, item["name"])
                else:
                    self.assertIsNotNone(got, item["name"])
                    assert got is not None
                    self.assertEqual(got[0], item["price"], item["name"])
                    self.assertEqual(got[1], item["reason"], item["name"])
            else:
                got = flip_lock.resolve_entry_limit_fill(bar, spec["side"], spec["limit"], spec["stop"])
                self.assertEqual(got, item["price"], item["name"])


class TimestampLockTest(unittest.TestCase):
    def _bars(self, count: int = 30) -> list[loop.Bar]:
        start = int(datetime(2026, 10, 26, 15, 0, tzinfo=timezone.utc).timestamp() * 1000)
        return [_bar(start + i * 60_000, 100, 100.25, 99.75, 100) for i in range(count)]

    def test_timestamp_window_matches_bar_indexes(self) -> None:
        bars = self._bars(40)
        locks = [flip_lock.TsFlipLock(exit_ts=bars[6].ts, stop_side="long")]
        self.assertIsNotNone(flip_lock.signal_flip_locked(locks, bars, "short", 7, 15))
        self.assertIsNotNone(flip_lock.signal_flip_locked(locks, bars, "short", 21, 15))
        self.assertIsNone(flip_lock.signal_flip_locked(locks, bars, "short", 22, 15))
        self.assertIsNone(flip_lock.signal_flip_locked(locks, bars, "long", 8, 15))
        self.assertIsNone(flip_lock.signal_flip_locked(locks, bars, "short", 6, 15))
        self.assertIsNone(flip_lock.signal_flip_locked(locks, bars, "short", 7, 0))

    def test_prune_keeps_a_lock_through_its_last_completed_bar(self) -> None:
        # Exit at 6, until 21. A buffer whose last completed index is 21 must keep it.
        bars = self._bars(23)  # indexes 0..22, last completed 21
        locks = [flip_lock.TsFlipLock(exit_ts=bars[6].ts, stop_side="long")]
        self.assertEqual(len(flip_lock.prune_flip_locks(locks, bars, 15)), 1)
        longer = self._bars(24)  # last completed 22 > 21
        self.assertEqual(flip_lock.prune_flip_locks(locks, longer, 15), [])

    def test_resolve_order_prefers_cli_then_env_and_stop_fill_wins(self) -> None:
        self.assertEqual(flip_lock.resolve_flip_lock_bars("0", "8", 15), 0)
        self.assertEqual(flip_lock.resolve_flip_lock_bars(None, "8", 15), 8)
        self.assertEqual(flip_lock.resolve_flip_lock_bars("  ", "", 0), 0)
        self.assertEqual(flip_lock.resolve_flip_lock_bars(None, None, None), 15)
        self.assertEqual(flip_lock.effective_flip_lock_bars("long", 15), 0)
        self.assertEqual(flip_lock.effective_flip_lock_bars("both", 15), 15)
        self.assertEqual(flip_lock.exit_reason_from_order_fills(True, True), "stop")
        self.assertEqual(flip_lock.exit_reason_from_order_fills(False, True), "target")
        self.assertIsNone(flip_lock.exit_reason_from_order_fills(False, False))


class ReplayAndDryRunTest(unittest.TestCase):
    def _series(self) -> list[loop.Bar]:
        start = int(datetime(2026, 10, 26, 15, 0, tzinfo=timezone.utc).timestamp() * 1000)
        bars = [_bar(start + i * 60_000, 100, 100.25, 99.75, 100, 10) for i in range(40)]
        bars[20] = _bar(bars[20].ts, 100, 110, 100, 110, 5000)
        bars[21] = _bar(bars[21].ts, 110, 110.25, 99, 105, 10)
        bars[22] = _bar(bars[22].ts, 110, 110, 100, 100, 5000)
        bars[25] = _bar(bars[25].ts, 100, 112, 100, 112, 5000)
        return bars

    def test_replay_arms_one_shared_lock_and_blocks_the_opposite_side(self) -> None:
        bars = self._series()
        locks = loop.replay_flip_locks(bars, loop.Filters(), "both", 15, 2.5, 2)
        self.assertTrue(any(lock.stop_side == "long" and lock.exit_ts == bars[21].ts for lock in locks))
        self.assertIsNotNone(flip_lock.signal_flip_locked(locks, bars, "short", 22, 15))
        self.assertIsNone(flip_lock.signal_flip_locked(locks, bars, "short", 21, 15))
        self.assertIsNone(flip_lock.signal_flip_locked(locks, bars, "long", 25, 15))
        self.assertIsNone(flip_lock.signal_flip_locked(locks, bars, "short", 21 + 16, 15))
        self.assertEqual(loop.replay_flip_locks(bars, loop.Filters(), "both", 0, 2.5, 2), [])
        self.assertEqual(loop.replay_flip_locks(bars, loop.Filters(), "long", 15, 2.5, 2), [])

    def test_dry_run_stop_blocks_opposite_and_allows_same_side(self) -> None:
        bars = self._series()
        with tempfile.TemporaryDirectory() as tmp:
            previous_state = loop.STATE_PATH
            previous_trades = loop.TRADES_PATH
            loop.STATE_PATH = Path(tmp) / "state.json"
            loop.TRADES_PATH = Path(tmp) / "trades.jsonl"
            try:
                runner = loop.PaperLoop(loop.Config(side="both", flipLockBars=15), place_orders=False, dry_run=True)
                for index in range(20, 26):
                    # Live buffers only include the forming bar after `index`, not later history.
                    runner.bars = bars[: index + 2]
                    runner._heartbeat_eval(index, source="test", allow_order=True)
                self.assertTrue(runner.state.flip_locks)
                self.assertIsNotNone(
                    flip_lock.signal_flip_locked(runner.state.flip_locks, bars, "short", 22, 15)
                )
                self.assertIsNotNone(runner.state.open)
                assert runner.state.open is not None
                self.assertEqual(runner.state.open.side, "long")
                self.assertTrue(runner.state.open.simulated)
                self.assertFalse(runner.state.open.entry_filled)
            finally:
                loop.STATE_PATH = previous_state
                loop.TRADES_PATH = previous_trades


if __name__ == "__main__":
    unittest.main()

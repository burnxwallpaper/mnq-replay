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

    def test_daytime_filter_default_min_body_matches_the_web(self) -> None:
        filters = loop.Filters()
        self.assertEqual(filters.minBody, 2.0)
        self.assertEqual(filters.bodyRatio, 0.2)
        self.assertEqual(filters.volLen, 10)
        self.assertEqual(filters.volMult, 0.2)
        example = json.loads((PAPER / "config.example.json").read_text(encoding="utf-8"))
        self.assertEqual(example["filters"]["minBody"], 2)
        self.assertEqual(example["flipLockBars"], 0)

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
        self.assertEqual(flip_lock.resolve_flip_lock_bars(None, None, None), 0)
        self.assertEqual(flip_lock.resolve_flip_lock_bars(None, None, 15), 15)
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


class _Contract:
    def __init__(self, con_id: int = 1) -> None:
        self.conId = con_id


class _Position:
    def __init__(self, qty: float, con_id: int = 1) -> None:
        self.contract = _Contract(con_id)
        self.position = qty


class _Order:
    def __init__(self, order_id: int) -> None:
        self.orderId = order_id


class _Status:
    def __init__(self, status: str, avg: float = 0.0, filled: float = 0.0) -> None:
        self.status = status
        self.avgFillPrice = avg
        self.filled = filled


class _Fill:
    def __init__(self, price: float, when: datetime) -> None:
        self.execution = type("_Exec", (), {"price": price})()
        self.time = when


class _Trade:
    def __init__(
        self,
        order_id: int,
        status: str,
        price: float | None = None,
        when: datetime | None = None,
    ) -> None:
        self.order = _Order(order_id)
        if price is None:
            self.fills = []
            self.orderStatus = _Status(status)
        else:
            self.fills = [_Fill(price, when or datetime.now(timezone.utc))]
            self.orderStatus = _Status(status, price, 1.0)


class _Gateway:
    """Minimal IB stand-in: position snapshot lags order status, like Paper Gateway."""

    def __init__(self) -> None:
        self.pos: list[_Position] = []
        self.book: list[_Trade] = []
        self.working: list[_Trade] = []
        self.cancelled: list[int] = []
        self.placed: list[object] = []

    def positions(self) -> list[_Position]:
        return self.pos

    def trades(self) -> list[_Trade]:
        return self.book

    def openTrades(self) -> list[_Trade]:
        return self.working

    def cancelOrder(self, order: _Order) -> None:
        self.cancelled.append(order.orderId)

    def placeOrder(self, *_args: object, **_kwargs: object) -> None:
        self.placed.append(_args)
        raise AssertionError("order placed")


class PaperOrderFillLagTest(unittest.TestCase):
    """Place-orders must not drop a bracket while positions() is still flat."""

    def setUp(self) -> None:
        self._prev_state = loop.STATE_PATH
        self._prev_trades = loop.TRADES_PATH
        self._tmp = tempfile.TemporaryDirectory()
        self.bars = self._make_bars()
        loop.STATE_PATH = Path(self._tmp.name) / "state.json"
        loop.TRADES_PATH = Path(self._tmp.name) / "trades.jsonl"
        self.gateway = _Gateway()
        self.runner = loop.PaperLoop(
            loop.Config(side="both", flipLockBars=15),
            place_orders=True,
            dry_run=False,
        )
        self.runner.bars = self.bars
        self.runner.ib = self.gateway
        self.runner.contract = _Contract()
        self.runner.state.open = self._pending()

    def tearDown(self) -> None:
        loop.STATE_PATH = self._prev_state
        loop.TRADES_PATH = self._prev_trades
        self._tmp.cleanup()

    def _make_bars(self) -> list[loop.Bar]:
        # 15:00 UTC = 10:00 CT on a Monday, inside the daytime entry window.
        start = int(datetime(2026, 10, 26, 15, 0, tzinfo=timezone.utc).timestamp() * 1000)
        bars = [_bar(start + i * 60_000, 100, 100.25, 99.75, 100, 10) for i in range(23)]
        bars[21] = _bar(bars[21].ts, 100, 100.25, 90, 90, 5000)
        return bars

    def _pending(self) -> loop.OpenTrade:
        return loop.OpenTrade(
            side="long",
            entry=100.0,
            stop=90.0,
            target=125.0,
            risk=10.0,
            entry_ts=self.bars[19].ts,
            qty=1,
            parent_order_id=6,
            tp_order_id=7,
            sl_order_id=8,
            entry_filled=False,
            signal_bar_ts=self.bars[19].ts,
            simulated=False,
        )

    def _at(self, index: int, extra_sec: int = 0) -> datetime:
        return datetime.fromtimestamp(self.bars[index].ts / 1000 + extra_sec, tz=timezone.utc)

    def test_empty_position_keeps_the_bracket_until_the_stop_arms_the_lock(self) -> None:
        # Same second as PLACE: trades() has nothing yet, positions() is flat.
        self.runner._sync_position_from_ib(20)
        self.assertIsNotNone(self.runner.state.open)
        assert self.runner.state.open is not None
        self.assertFalse(self.runner.state.open.entry_filled)
        self.assertEqual(self.runner.state.flip_locks, [])
        self.assertEqual(self.runner.state.closed_count, 0)

        working = _Trade(6, "Submitted")
        self.gateway.book.append(working)
        with self.assertLogs("ib_paper_loop", level="INFO") as pending_logs:
            self.runner._heartbeat_eval(20, source="test", allow_order=True)
        pending_text = "\n".join(pending_logs.output)
        self.assertIn("pending-long", pending_text)
        self.assertNotIn("clearing local open state", pending_text)
        self.assertIsNotNone(self.runner.state.open)

        # Inactive is not a cancel. A just-transmitted bracket can report it.
        self.gateway.book[0] = _Trade(6, "Inactive")
        self.runner._sync_position_from_ib(20)
        self.assertIsNotNone(self.runner.state.open)

        # Parent filled; position snapshot still empty; the bar even trades the stop.
        # That must not book a close before a child fill or a real position.
        assert self.runner.state.open is not None
        self.runner.state.open.stop = 99.75
        self.gateway.book[0] = _Trade(6, "Filled", price=100.25, when=self._at(20, 1))
        self.runner._sync_position_from_ib(20)
        assert self.runner.state.open is not None
        self.assertTrue(self.runner.state.open.entry_filled)
        self.assertFalse(self.runner.state.open.position_seen)
        self.assertEqual(self.runner.state.open.entry, 100.25)
        self.assertEqual(self.runner.state.closed_count, 0)
        self.assertEqual(self.runner.state.flip_locks, [])

        self.runner.state.open.stop = 90.0
        self.gateway.pos.append(_Position(1))
        self.runner._sync_position_from_ib(20)
        assert self.runner.state.open is not None
        self.assertTrue(self.runner.state.open.position_seen)
        self.assertEqual(self.runner.state.closed_count, 0)

        # Stop fills a few seconds into the stop bar. Position snapshot is flat again.
        self.gateway.pos.clear()
        self.gateway.book.append(_Trade(8, "Filled", price=90.0, when=self._at(20, 24)))
        with self.assertLogs("ib_paper_loop", level="INFO") as stop_logs:
            self.runner._heartbeat_eval(21, source="test", allow_order=True)
        stop_text = "\n".join(stop_logs.output)
        self.assertIn("CLOSED stop", stop_text)
        self.assertIn("FLIP-LOCK armed", stop_text)
        self.assertIn("SIGNAL short", stop_text)
        self.assertIn("flip_lock=True", stop_text)
        self.assertIn("FLIP-LOCK block short", stop_text)
        self.assertNotIn("clearing local open state", stop_text)
        self.assertIsNone(self.runner.state.open)
        self.assertEqual(self.gateway.placed, [])
        self.assertEqual(self.runner.state.closed_count, 1)
        self.assertEqual(len(self.runner.state.flip_locks), 1)
        self.assertEqual(self.runner.state.flip_locks[0].exit_ts, self.bars[20].ts)
        self.assertEqual(self.runner.state.flip_locks[0].stop_side, "long")
        locks = self.runner.state.flip_locks
        self.assertIsNone(flip_lock.signal_flip_locked(locks, self.bars, "short", 20, 15))
        self.assertIsNotNone(flip_lock.signal_flip_locked(locks, self.bars, "short", 21, 15))
        self.assertIsNotNone(flip_lock.signal_flip_locked(locks, self.bars, "short", 35, 15))
        self.assertIsNone(flip_lock.signal_flip_locked(locks, self.bars, "short", 36, 15))
        self.assertIsNone(flip_lock.signal_flip_locked(locks, self.bars, "long", 21, 15))

    def test_stop_fill_arms_lock_when_the_position_snapshot_never_arrives(self) -> None:
        when = self._at(20, 24)
        self.gateway.book = [
            _Trade(6, "Filled", price=100.25, when=self._at(20, 1)),
            _Trade(8, "Filled", price=90.0, when=when),
        ]
        self.runner._sync_position_from_ib(20)
        self.assertIsNone(self.runner.state.open)
        self.assertEqual(self.runner.state.closed_count, 1)
        self.assertEqual(len(self.runner.state.flip_locks), 1)
        self.assertEqual(self.runner.state.flip_locks[0].stop_side, "long")
        self.assertEqual(self.runner.state.flip_locks[0].exit_ts, self.bars[20].ts)
        self.assertIsNotNone(
            flip_lock.signal_flip_locked(self.runner.state.flip_locks, self.bars, "short", 21, 15)
        )

    def test_target_fill_does_not_arm_and_cancelled_parent_does_not_book(self) -> None:
        self.gateway.book = [
            _Trade(6, "Filled", price=100.0, when=self._at(20, 1)),
            _Trade(7, "Filled", price=125.0, when=self._at(20, 30)),
        ]
        with self.assertLogs("ib_paper_loop", level="INFO") as target_logs:
            self.runner._sync_position_from_ib(20)
        target_text = "\n".join(target_logs.output)
        self.assertIn("CLOSED target", target_text)
        self.assertNotIn("FLIP-LOCK armed", target_text)
        self.assertEqual(self.runner.state.flip_locks, [])
        self.assertEqual(self.runner.state.closed_count, 1)

        self.runner.state.open = self._pending()
        self.runner.state.closed_count = 0
        self.gateway.book = [_Trade(6, "Cancelled")]
        with self.assertLogs("ib_paper_loop", level="INFO") as cancel_logs:
            self.runner._sync_position_from_ib(20)
        self.assertIn("clearing local open state", "\n".join(cancel_logs.output))
        self.assertIsNone(self.runner.state.open)
        self.assertEqual(self.runner.state.closed_count, 0)
        self.assertEqual(self.runner.state.flip_locks, [])

        self.runner.state.open = self._pending()
        self.gateway.book = [_Trade(6, "ApiCancelled")]
        self.runner._sync_position_from_ib(20)
        self.assertIsNone(self.runner.state.open)
        self.assertEqual(self.runner.state.flip_locks, [])

    def test_entry_limit_expiry_still_cancels_a_resting_parent(self) -> None:
        assert self.runner.state.open is not None
        self.runner.state.open.signal_bar_ts = self.bars[18].ts
        resting = _Trade(6, "Submitted")
        self.gateway.book = [resting]
        self.gateway.working = [resting]
        with self.assertLogs("ib_paper_loop", level="INFO") as logs:
            self.runner._heartbeat_eval(20, source="test", allow_order=True)
        text = "\n".join(logs.output)
        self.assertIn("EXPIRE unfilled", text)
        self.assertNotIn("clearing local open state", text)
        self.assertEqual(self.gateway.cancelled, [6])
        self.assertIsNone(self.runner.state.open)
        self.assertEqual(self.runner.state.flip_locks, [])
        self.assertEqual(self.runner.state.closed_count, 0)

    def test_short_position_marks_the_entry_without_dropping_it(self) -> None:
        assert self.runner.state.open is not None
        self.runner.state.open.side = "short"
        self.gateway.pos.append(_Position(-1))
        self.runner._sync_position_from_ib(20)
        assert self.runner.state.open is not None
        self.assertTrue(self.runner.state.open.entry_filled)
        self.assertTrue(self.runner.state.open.position_seen)
        self.assertEqual(self.runner.state.closed_count, 0)

    def test_restart_with_no_orders_and_a_flat_book_still_arms_from_the_bar(self) -> None:
        assert self.runner.state.open is not None
        self.runner.state.open.entry_filled = True
        self.runner.state.open.position_seen = False
        self.runner.state.open.stop = 99.75
        self.runner._sync_position_from_ib(20)
        self.assertIsNone(self.runner.state.open)
        self.assertEqual(self.runner.state.closed_count, 1)
        self.assertEqual(len(self.runner.state.flip_locks), 1)
        self.assertEqual(self.runner.state.flip_locks[0].exit_ts, self.bars[20].ts)

    def test_saved_state_without_position_seen_treats_a_filled_entry_as_seen(self) -> None:
        loop.STATE_PATH.write_text(
            json.dumps(
                {
                    "open": {
                        "side": "long",
                        "entry": 100,
                        "stop": 90,
                        "target": 125,
                        "risk": 10,
                        "entry_filled": True,
                    }
                }
            ),
            encoding="utf-8",
        )
        loaded = loop.load_state(loop.Config())
        assert loaded.open is not None
        self.assertTrue(loaded.open.entry_filled)
        self.assertTrue(loaded.open.position_seen)

        loop.STATE_PATH.write_text(
            json.dumps(
                {
                    "open": {
                        "side": "short",
                        "entry": 100,
                        "stop": 110,
                        "target": 80,
                        "risk": 10,
                        "entry_filled": True,
                        "position_seen": False,
                    }
                }
            ),
            encoding="utf-8",
        )
        lagged = loop.load_state(loop.Config())
        assert lagged.open is not None
        self.assertTrue(lagged.open.entry_filled)
        self.assertFalse(lagged.open.position_seen)

    def test_zero_bars_books_the_stop_without_arming(self) -> None:
        self.runner.flip_lock_bars = 0
        self.gateway.book = [
            _Trade(6, "Filled", price=100.0, when=self._at(20, 1)),
            _Trade(8, "Filled", price=90.0, when=self._at(20, 24)),
        ]
        with self.assertLogs("ib_paper_loop", level="INFO") as logs:
            self.runner._sync_position_from_ib(20)
        text = "\n".join(logs.output)
        self.assertIn("CLOSED stop", text)
        self.assertNotIn("FLIP-LOCK armed", text)
        self.assertEqual(self.runner.state.flip_locks, [])
        self.assertEqual(self.runner.state.closed_count, 1)


if __name__ == "__main__":
    unittest.main()

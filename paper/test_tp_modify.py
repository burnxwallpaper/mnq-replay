#!/usr/bin/env python3
"""EMA 1R take-profit modify must not revise the OCA group or its type.

IB 10326 rejects a group-name revision. IB 10327 rejects a type revision.
ocaType 0 is the text "0" on the wire, so a price-only modify has to omit
the type with ib_insync's UNSET integer. Either reject leaves the live
target and OCA unchanged and must not be logged as Modified.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

PAPER = Path(__file__).resolve().parent
if str(PAPER) not in sys.path:
    sys.path.insert(0, str(PAPER))

import ib_paper_loop as loop  # noqa: E402


def _bar(ts: int, o: float, h: float, l: float, c: float, v: float = 10) -> loop.Bar:
    return loop.Bar(ts=ts, o=o, h=h, l=l, c=c, v=v)


def _wire_field(value: object) -> str:
    """Empty-field rule from ib_insync.client.Client.send (makeEmpty=True).

    None and UNSET_INTEGER/UNSET_DOUBLE are omitted. Every other value,
    including the integer 0 and the empty string, is written with str().
    An empty string is therefore an empty field; integer 0 is the text "0".
    """
    if value is None or value == loop._OCA_TYPE_UNSET or value == sys.float_info.max:
        return ""
    return str(value)


class _Contract:
    def __init__(self, con_id: int = 1) -> None:
        self.conId = con_id


class _Position:
    def __init__(self, qty: float, con_id: int = 1) -> None:
        self.contract = _Contract(con_id)
        self.position = qty


class _Order:
    def __init__(self, order_id: int, lmt: float, oca: str) -> None:
        self.orderId = order_id
        self.lmtPrice = lmt
        self.auxPrice = 0.0
        self.ocaGroup = oca
        self.ocaType = 1
        self.transmit = False
        self.parentId = 6
        self.action = "SELL"
        self.totalQuantity = 1
        self.orderType = "LMT"
        self.tif = "GTC"
        self.permId = 0


class _Trade:
    def __init__(self, order: _Order) -> None:
        self.order = order


class _Event:
    def __init__(self) -> None:
        self._handlers: list = []

    def __iadd__(self, handler):  # noqa: ANN001
        self._handlers.append(handler)
        return self

    def __isub__(self, handler):  # noqa: ANN001
        self._handlers = [item for item in self._handlers if item != handler]
        return self

    def emit(self, *args: object) -> None:
        for handler in list(self._handlers):
            handler(*args)


class _Gateway:
    """Records the order object placeOrder actually submits."""

    def __init__(self) -> None:
        self.pos: list[_Position] = []
        self.working: list[_Trade] = []
        self.book: list[_Trade] = []
        self.submitted: list[dict[str, object]] = []
        self.cancelled: list[int] = []
        self.slept: list[float] = []
        self.errors_on_sleep: list[tuple[int, int, str]] = []
        self.raise_on_place = False
        self.errorEvent = _Event()

    def positions(self) -> list[_Position]:
        return self.pos

    def openTrades(self) -> list[_Trade]:
        return list(self.working)

    def trades(self) -> list[_Trade]:
        return self.book

    def cancelOrder(self, order: _Order) -> None:
        self.cancelled.append(order.orderId)

    def placeOrder(self, _contract: object, order: _Order) -> None:
        live_tp = next(item.order for item in self.working if item.order.orderId == order.orderId)
        self.submitted.append(
            {
                "orderId": order.orderId,
                "lmtPrice": order.lmtPrice,
                "ocaGroup": order.ocaGroup,
                "ocaType": order.ocaType,
                "transmit": order.transmit,
                "parentId": order.parentId,
                "action": order.action,
                "totalQuantity": order.totalQuantity,
                "same_object": order is live_tp,
                "live_oca": live_tp.ocaGroup,
                "live_oca_type": live_tp.ocaType,
                "live_lmt": live_tp.lmtPrice,
            }
        )
        if self.raise_on_place:
            raise RuntimeError("socket down")

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        for req_id, code, text in self.errors_on_sleep:
            self.errorEvent.emit(req_id, code, text, None)


class TakeProfitModifyTest(unittest.TestCase):
    def setUp(self) -> None:
        self._prev_state = loop.STATE_PATH
        self._prev_trades = loop.TRADES_PATH
        self._tmp = tempfile.TemporaryDirectory()
        loop.STATE_PATH = Path(self._tmp.name) / "state.json"
        loop.TRADES_PATH = Path(self._tmp.name) / "trades.jsonl"
        self.bars = self._make_bars()
        self.gateway = _Gateway()
        self.runner = loop.PaperLoop(
            loop.Config(side="both", flipLockBars=15),
            place_orders=True,
            dry_run=False,
        )
        self.runner.bars = self.bars
        self.runner.ib = self.gateway
        self.runner.contract = _Contract()
        self.runner.state.open = self._open_trade()
        self.gateway.pos = [_Position(1)]
        self._reset_book()

    def tearDown(self) -> None:
        loop.STATE_PATH = self._prev_state
        loop.TRADES_PATH = self._prev_trades
        self._tmp.cleanup()

    def _make_bars(self) -> list[loop.Bar]:
        # 15:00 UTC = 10:00 CT Monday. Close 98 is under EMA5 and above the stop.
        start = int(datetime(2026, 10, 26, 15, 0, tzinfo=timezone.utc).timestamp() * 1000)
        bars = [_bar(start + i * 60_000, 100, 100.25, 99.75, 100, 10) for i in range(8)]
        bars[7] = _bar(bars[7].ts, 100, 100.25, 97, 98, 10)
        return bars

    def _open_trade(self) -> loop.OpenTrade:
        return loop.OpenTrade(
            side="long",
            entry=100.0,
            stop=90.0,
            target=125.0,
            risk=10.0,
            entry_ts=self.bars[0].ts,
            qty=1,
            parent_order_id=6,
            tp_order_id=7,
            sl_order_id=8,
            tightened=False,
            entry_filled=True,
            signal_bar_ts=self.bars[0].ts,
            position_seen=True,
            simulated=False,
        )

    def _reset_book(self) -> None:
        oca = "mnq-6"
        self.tp = _Order(7, 125.0, oca)
        self.sl = _Order(8, 0.0, oca)
        self.sl.orderType = "STP"
        self.sl.auxPrice = 90.0
        self.gateway.working = [_Trade(self.tp), _Trade(self.sl)]
        self.gateway.submitted.clear()
        self.gateway.cancelled.clear()
        self.gateway.slept.clear()
        self.gateway.errors_on_sleep = []
        self.gateway.raise_on_place = False
        assert self.runner.state.open is not None
        self.runner.state.open.target = 125.0
        self.runner.state.open.tightened = False
        self.runner.state.open.entry_filled = True
        self.runner.state.open.position_seen = True

    def _eval(self) -> str:
        # Hybrid strategy no longer emits EMA tighten; inject for TP-modify plumbing tests.
        def _fake_eval(*_a, **_k):
            return loop.EvalResult(tighten_target=110.0)

        prev = loop.evaluate_bar
        loop.evaluate_bar = _fake_eval  # type: ignore[assignment]
        try:
            with self.assertLogs("ib_paper_loop", level="INFO") as logs:
                self.runner._heartbeat_eval(7, source="test", allow_order=True)
        finally:
            loop.evaluate_bar = prev  # type: ignore[assignment]
        return "\n".join(logs.output)

    def test_ema_tighten_submits_a_price_only_modify(self) -> None:
        assert self.runner.state.open is not None
        # Stacked-EMA hybrid does not set tighten; plumbing still accepts injected target.
        preview = loop.evaluate_bar(
            self.bars,
            7,
            self.runner.cfg.filters,
            self.runner.cfg.side,
            self.runner.state.open,
            self.runner.cfg.rewardMultiple,
        )
        self.assertIsNone(preview.tighten_target)

        text = self._eval()
        self.assertIn("TIGHTEN long target 125.00 -> 110.00 (1R)", text)
        self.assertIn("Modified TP order 7 -> 110.00 (OCA omitted on modify; group mnq-6 kept)", text)
        self.assertNotIn("10326", text)
        self.assertNotIn("10327", text)
        self.assertNotIn("TIGHTEN not applied", text)

        self.assertTrue(self.runner.state.open.tightened)
        self.assertEqual(self.runner.state.open.target, 110.0)
        self.assertEqual(self.tp.lmtPrice, 110.0)
        self.assertEqual(self.tp.ocaGroup, "mnq-6")
        self.assertEqual(self.tp.ocaType, 1)
        self.assertFalse(self.tp.transmit)
        self.assertEqual(self.tp.parentId, 6)
        self.assertEqual(self.sl.ocaGroup, "mnq-6")
        self.assertEqual(self.sl.ocaType, 1)
        self.assertEqual(self.sl.auxPrice, 90.0)
        self.assertEqual(self.gateway.cancelled, [])
        self.assertEqual(len(self.gateway.submitted), 1)
        sent = self.gateway.submitted[0]
        self.assertEqual(sent["orderId"], 7)
        self.assertEqual(sent["lmtPrice"], 110.0)
        self.assertEqual(sent["ocaGroup"], "")
        self.assertEqual(sent["ocaType"], loop._OCA_TYPE_UNSET)
        self.assertNotEqual(sent["ocaType"], 0)
        self.assertEqual(_wire_field(sent["ocaGroup"]), "")
        self.assertEqual(_wire_field(sent["ocaType"]), "")
        self.assertEqual(_wire_field(0), "0")
        self.assertTrue(sent["transmit"])
        self.assertEqual(sent["parentId"], 6)
        self.assertEqual(sent["action"], "SELL")
        self.assertEqual(sent["totalQuantity"], 1)
        self.assertFalse(sent["same_object"])
        self.assertEqual(sent["live_oca"], "mnq-6")
        self.assertEqual(sent["live_oca_type"], 1)
        self.assertEqual(sent["live_lmt"], 125.0)
        self.assertEqual(self.gateway.slept, [loop._TP_MODIFY_ACK_SEC])

        self.runner._heartbeat_eval(7, source="test", allow_order=True)
        self.assertEqual(len(self.gateway.submitted), 1)
        self.assertTrue(self.runner.state.open.tightened)
        self.assertEqual(self.runner.state.open.target, 110.0)

    def test_ib_reject_leaves_target_and_oca_unchanged(self) -> None:
        cases = (
            (10326, "OCA group revision is not allowed"),
            (10327, "OCA group type revision is not allowed"),
            (201, "Order rejected"),
        )
        for code, message in cases:
            with self.subTest(code=code):
                self._reset_book()
                self.gateway.errors_on_sleep = [(7, code, message)]
                text = self._eval()
                self.assertIn("TIGHTEN not applied long IB target stays 125.00", text)
                self.assertIn(f"code={code}", text)
                self.assertNotIn("Modified TP order", text)
                assert self.runner.state.open is not None
                self.assertFalse(self.runner.state.open.tightened)
                self.assertEqual(self.runner.state.open.target, 125.0)
                self.assertEqual(self.tp.lmtPrice, 125.0)
                self.assertEqual(self.tp.ocaGroup, "mnq-6")
                self.assertEqual(self.tp.ocaType, 1)
                self.assertEqual(self.sl.ocaGroup, "mnq-6")
                self.assertEqual(self.gateway.cancelled, [])
                self.assertEqual(self.gateway.submitted[-1]["orderId"], 7)
                self.assertEqual(self.gateway.submitted[-1]["ocaGroup"], "")
                self.assertEqual(self.gateway.submitted[-1]["ocaType"], loop._OCA_TYPE_UNSET)
                self.assertEqual(self.gateway.submitted[-1]["lmtPrice"], 110.0)
                self.assertEqual(self.gateway.submitted[-1]["live_lmt"], 125.0)
                self.assertEqual(self.gateway.submitted[-1]["live_oca"], "mnq-6")
                self.assertEqual(self.gateway.submitted[-1]["live_oca_type"], 1)

    def test_oca_warning_and_unrelated_reject_still_count_as_accepted(self) -> None:
        # 2109 means the price change was processed and the group was not revised.
        self.gateway.errors_on_sleep = [
            (7, 2109, "Attempted modify of OcaGroup will not be done. Order modify now being processed."),
            (99, 10326, "OCA group revision is not allowed"),
            (99, 10327, "OCA group type revision is not allowed"),
        ]
        text = self._eval()
        self.assertIn("Modified TP order 7 -> 110.00", text)
        self.assertNotIn("TIGHTEN not applied", text)
        assert self.runner.state.open is not None
        self.assertTrue(self.runner.state.open.tightened)
        self.assertEqual(self.runner.state.open.target, 110.0)
        self.assertEqual(self.tp.lmtPrice, 110.0)
        self.assertEqual(self.tp.ocaGroup, "mnq-6")
        self.assertEqual(self.gateway.cancelled, [])

    def test_place_order_exception_does_not_pretend_the_tp_moved(self) -> None:
        self.gateway.raise_on_place = True
        text = self._eval()
        self.assertIn("TP modify failed for order 7", text)
        self.assertIn("TIGHTEN not applied long IB target stays 125.00", text)
        assert self.runner.state.open is not None
        self.assertFalse(self.runner.state.open.tightened)
        self.assertEqual(self.runner.state.open.target, 125.0)
        self.assertEqual(self.tp.lmtPrice, 125.0)
        self.assertEqual(self.tp.ocaGroup, "mnq-6")
        self.assertEqual(self.tp.ocaType, 1)
        self.assertFalse(self.tp.transmit)
        self.assertEqual(self.sl.ocaGroup, "mnq-6")
        self.assertEqual(self.gateway.slept, [])
        self.assertEqual(self.gateway.cancelled, [])
        self.assertEqual(self.gateway.submitted[0]["ocaGroup"], "")
        self.assertEqual(self.gateway.submitted[0]["ocaType"], loop._OCA_TYPE_UNSET)
        self.assertFalse(self.gateway.submitted[0]["same_object"])

    def test_missing_tp_does_not_mark_tightened_or_cancel_the_stop(self) -> None:
        self.gateway.working = [_Trade(self.sl)]
        text = self._eval()
        self.assertIn("not found in openTrades", text)
        self.assertIn("TIGHTEN not applied", text)
        assert self.runner.state.open is not None
        self.assertFalse(self.runner.state.open.tightened)
        self.assertEqual(self.runner.state.open.target, 125.0)
        self.assertEqual(self.gateway.submitted, [])
        self.assertEqual(self.gateway.cancelled, [])
        self.assertEqual(self.sl.ocaGroup, "mnq-6")

    def test_dry_run_tightens_the_virtual_target_without_an_order(self) -> None:
        runner = loop.PaperLoop(loop.Config(), place_orders=False, dry_run=True)
        runner.bars = self.bars
        runner.ib = self.gateway
        runner.contract = _Contract()
        runner.state.open = self._open_trade()
        assert runner.state.open is not None
        runner.state.open.simulated = True
        self.gateway.submitted.clear()
        self.gateway.cancelled.clear()
        def _fake_eval(*_a, **_k):
            return loop.EvalResult(tighten_target=110.0)
        prev = loop.evaluate_bar
        loop.evaluate_bar = _fake_eval  # type: ignore[assignment]
        try:
            with self.assertLogs("ib_paper_loop", level="INFO") as logs:
                runner._heartbeat_eval(7, source="test", allow_order=True)
        finally:
            loop.evaluate_bar = prev  # type: ignore[assignment]
        text = "\n".join(logs.output)
        self.assertIn("TIGHTEN long target 125.00 -> 110.00 (1R)", text)
        self.assertNotIn("Modified TP order", text)
        self.assertTrue(runner.state.open.tightened)
        self.assertEqual(runner.state.open.target, 110.0)
        self.assertEqual(self.gateway.submitted, [])
        self.assertEqual(self.gateway.cancelled, [])
        self.assertEqual(self.tp.lmtPrice, 125.0)
        self.assertEqual(self.tp.ocaGroup, "mnq-6")


if __name__ == "__main__":
    unittest.main()

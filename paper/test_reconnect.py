#!/usr/bin/env python3
"""Reconnect the Paper loop without a second bracket or a stuck SIGTERM."""
from __future__ import annotations

import signal
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

PAPER = Path(__file__).resolve().parent
if str(PAPER) not in sys.path:
    sys.path.insert(0, str(PAPER))

import ib_paper_loop as loop  # noqa: E402


def _ib_bar(ts_ms: int, o: float, h: float, l: float, c: float, v: float) -> SimpleNamespace:
    return SimpleNamespace(
        date=datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc),
        open=o,
        high=h,
        low=l,
        close=c,
        volume=v,
    )


class _Event:
    def __init__(self) -> None:
        self._handlers: list = []

    def __iadd__(self, handler: object) -> "_Event":
        self._handlers.append(handler)
        return self

    def __isub__(self, handler: object) -> "_Event":
        self._handlers = [item for item in self._handlers if item != handler]
        return self

    def emit(self, *args: object) -> None:
        for handler in list(self._handlers):
            handler(*args)


class _Hist:
    def __init__(self, bars: list) -> None:
        self.updateEvent = _Event()
        self.bars = list(bars)

    def __iter__(self) -> object:
        return iter(self.bars)

    def append_next(self) -> None:
        last = self.bars[-1]
        ts_ms = int(last.date.timestamp() * 1000) + 60_000
        self.bars.append(_ib_bar(ts_ms, 100, 100, 100, 100, 10))


class _Contract:
    def __init__(self) -> None:
        self.localSymbol = "MNQ"
        self.conId = 1
        self.lastTradeDateOrContractMonth = "20991218"
        self.exchange = "CME"
        self.multiplier = "2"


class _World:
    def __init__(self) -> None:
        self.ibs: list = []
        self.connect_args: list = []
        self.histories: list = []
        self.qualifies: list = []
        self.waits: list = []
        self.placed: list = []
        self.open_order_requests = 0
        self.phase = "start"
        self.ticks = 0
        self.restores = 0
        self.live_handlers: list = []
        self.runner: loop.PaperLoop | None = None
        self.base_bars: list = []
        self.contract = _Contract()
        self.drop = "socket"
        self.emit_bar = True
        self.sigterm = False


class _FakeIB:
    """Stand-in for ib_insync.IB. No socket. Events match the real names."""

    def __init__(self, world: _World) -> None:
        self.world = world
        self.disconnectedEvent = _Event()
        self.errorEvent = _Event()
        self.connected = False
        self.disconnects = 0
        world.ibs.append(self)

    def connect(self, host: str, port: int, clientId: int = 1, readonly: bool = False, timeout: float = 4) -> None:
        self.world.connect_args.append((host, port, clientId, readonly))
        if len(self.world.connect_args) > 4:
            assert self.world.runner is not None
            self.world.runner._stopping = True
            raise RuntimeError("too many connects")
        self.connected = True

    def disconnect(self) -> None:
        was = self.connected
        self.connected = False
        self.disconnects += 1
        if was:
            self.disconnectedEvent.emit()

    def isConnected(self) -> bool:
        return self.connected

    def managedAccounts(self) -> list[str]:
        return ["PAPER"]

    def sleep(self, seconds: float) -> None:
        if float(seconds) != 1.0:
            return
        world = self.world
        if world.runner is None or world.runner.ib is not self:
            return
        world.ticks += 1
        if world.ticks > 6:
            world.runner._stopping = True
            return
        if not self.connected:
            return
        if world.phase == "start":
            world.phase = "down"
            if world.drop == "1100":
                self.errorEvent.emit(-1, 1100, "Connectivity between IB and TWS has been lost.", None)
                return
            if world.drop == "error":
                self.connected = False
                raise ConnectionError("Not connected")
            self.connected = False
            self.disconnectedEvent.emit()
            return
        if world.phase == "down":
            world.phase = "streamed"
            if world.emit_bar and world.histories:
                hist = world.histories[-1][1]
                world.live_handlers = list(hist.updateEvent._handlers)
                hist.append_next()
                hist.updateEvent.emit(hist, True)
            world.runner._stopping = True

    def reqHistoricalData(self, *_args: object, **kwargs: object) -> _Hist:
        hist = _Hist(self.world.base_bars)
        self.world.histories.append((bool(kwargs.get("keepUpToDate")), hist, self))
        return hist

    def cancelHistoricalData(self, bars: object) -> None:
        del bars

    def reqOpenOrders(self) -> list:
        self.world.open_order_requests += 1
        return []

    def positions(self) -> list:
        return []

    def trades(self) -> list:
        return []

    def openTrades(self) -> list:
        return []

    def placeOrder(self, *args: object, **kwargs: object) -> None:
        del kwargs
        self.world.placed.append(args)

    def cancelOrder(self, order: object) -> None:
        del order


class ReconnectTest(unittest.TestCase):
    def setUp(self) -> None:
        self._prev_state = loop.STATE_PATH
        self._prev_trades = loop.TRADES_PATH
        self._orig_qualify = loop.qualify_front_mnq
        self._tmp = tempfile.TemporaryDirectory()
        loop.STATE_PATH = Path(self._tmp.name) / "state.json"
        loop.TRADES_PATH = Path(self._tmp.name) / "trades.jsonl"
        self.world = _World()
        loop.qualify_front_mnq = self._qualify

    def tearDown(self) -> None:
        loop.qualify_front_mnq = self._orig_qualify
        loop.STATE_PATH = self._prev_state
        loop.TRADES_PATH = self._prev_trades
        self._tmp.cleanup()

    def _qualify(self, ib: object, cfg: loop.Config) -> _Contract:
        del cfg
        self.world.qualifies.append(ib)
        return self.world.contract

    def _run(
        self,
        *,
        place_orders: bool,
        drop: str = "socket",
        signal_bar: bool = False,
        sigterm: bool = False,
        emit_bar: bool = True,
        prepare: object = None,
    ) -> loop.PaperLoop:
        start = int(datetime(2026, 10, 26, 15, 0, tzinfo=timezone.utc).timestamp() * 1000)
        bars = [_ib_bar(start + i * 60_000, 100, 100, 100, 100, 10) for i in range(3)]
        if signal_bar:
            bars[2] = _ib_bar(start + 2 * 60_000, 100, 110, 98, 109, 50_000)
        self.world.base_bars = bars
        self.world.drop = drop
        self.world.sigterm = sigterm
        self.world.emit_bar = emit_bar
        self.start = start
        cfg = loop.Config(ibHost="127.0.0.1", ibPort=4002, clientId=17, side="both", flipLockBars=15)
        runner = loop.PaperLoop(cfg, place_orders=place_orders, dry_run=not place_orders)
        self.world.runner = runner
        runner._make_ib = lambda: _FakeIB(self.world)

        def wait(seconds: float) -> None:
            self.world.waits.append(seconds)
            if self.world.sigterm:
                signal.raise_signal(signal.SIGTERM)

        runner._wait = wait  # type: ignore[method-assign]
        if prepare is not None:
            prepare(runner)  # type: ignore[operator]
        runner.run_forever()
        return runner

    def test_backoff_caps_at_thirty_seconds(self) -> None:
        self.assertEqual(loop.reconnect_backoff_seconds(1), 1)
        self.assertEqual(loop.reconnect_backoff_seconds(2), 2)
        self.assertEqual(loop.reconnect_backoff_seconds(3), 4)
        self.assertEqual(loop.reconnect_backoff_seconds(5), 16)
        self.assertEqual(loop.reconnect_backoff_seconds(6), 30)
        self.assertEqual(loop.reconnect_backoff_seconds(12), 30)

    def test_lost_connection_codes_reconnect_and_farm_notices_do_not(self) -> None:
        runner = loop.PaperLoop(loop.Config(), place_orders=False, dry_run=True)
        with self.assertLogs("ib_paper_loop", level="WARNING") as logs:
            runner._on_ib_error(1, 2103, "Market data farm connection is broken", None)
            runner._on_ib_error(1, 1101, "Connectivity restored, data lost", None)
            runner._on_ib_error(1, 1102, "Connectivity restored, data maintained", None)
            self.assertFalse(runner._disconnected)
            for code in (1100, 502, 504, 1300):
                runner._disconnected = False
                runner._on_ib_error(1, code, "lost", None)
                self.assertTrue(runner._disconnected, code)
            runner._reconnecting = True
            runner._disconnected = False
            runner._lost_during_connect = False
            runner._on_ib_error(1, 1100, "lost", None)
            runner._on_disconnected()
        self.assertFalse(runner._disconnected)
        self.assertTrue(runner._lost_during_connect)
        text = "\n".join(logs.output)
        self.assertNotIn("2103", text)
        self.assertIn("IB error 1100", text)

    def test_disconnect_reconnects_and_restores_the_stream(self) -> None:
        with self.assertLogs("ib_paper_loop", level="INFO") as logs:
            runner = self._run(place_orders=False, drop="socket")
        text = "\n".join(logs.output)
        self.assertIn("Disconnect detected", text)
        self.assertIn("Reconnect attempt 1 to 127.0.0.1:4002 clientId=17", text)
        self.assertIn("Reconnect succeeded", text)
        self.assertEqual(
            self.world.connect_args,
            [("127.0.0.1", 4002, 17, True), ("127.0.0.1", 4002, 17, True)],
        )
        self.assertEqual(self.world.qualifies, self.world.ibs)
        self.assertEqual([item[0] for item in self.world.histories], [True, True])
        self.assertEqual(len(self.world.histories), 2)
        old = self.world.histories[0][1]
        hist = self.world.histories[-1][1]
        self.assertEqual(old.updateEvent._handlers, [])
        self.assertIn(runner._on_bar_update, self.world.live_handlers)
        self.assertEqual(hist.updateEvent._handlers, [])
        self.assertEqual(len(hist.bars), 4)
        self.assertEqual(runner._last_processed_ts, self.start + 120_000)
        self.assertEqual(self.world.placed, [])
        self.assertEqual(self.world.waits, [1.0])
        self.assertEqual(self.world.phase, "streamed")

    def test_error_1100_reconnects_while_the_socket_still_looks_up(self) -> None:
        with self.assertLogs("ib_paper_loop", level="INFO") as logs:
            runner = self._run(place_orders=False, drop="1100")
        text = "\n".join(logs.output)
        self.assertIn("Disconnect detected: IB error 1100:", text)
        self.assertIn("Reconnect succeeded", text)
        self.assertEqual(len(self.world.connect_args), 2)
        self.assertEqual(self.world.ibs[0].disconnects, 1)
        self.assertFalse(self.world.ibs[0].connected)
        self.assertEqual([item[0] for item in self.world.histories], [True, True])
        self.assertEqual(runner._last_processed_ts, self.start + 120_000)
        self.assertIn(runner._on_bar_update, self.world.live_handlers)

    def test_sleep_connection_error_reconnects_and_restores_the_stream(self) -> None:
        with self.assertLogs("ib_paper_loop", level="INFO") as logs:
            runner = self._run(place_orders=False, drop="error")
        text = "\n".join(logs.output)
        self.assertIn("Disconnect detected: Not connected", text)
        self.assertIn("Reconnect succeeded", text)
        self.assertEqual(len(self.world.histories), 2)
        self.assertEqual(runner._last_processed_ts, self.start + 120_000)

    def test_reconnect_does_not_place_a_second_bracket(self) -> None:
        placed: list = []

        def prepare(runner: loop.PaperLoop) -> None:
            def spy(sig: loop.Signal, signal_bar_ts: int) -> None:
                placed.append((sig.side, signal_bar_ts))

            runner._place_bracket = spy  # type: ignore[method-assign]
            start = self.start
            runner.state.equity = 12345.5
            runner.state.open = loop.OpenTrade(
                side="long",
                entry=100.0,
                stop=90.0,
                target=125.0,
                risk=10.0,
                entry_ts=start,
                qty=1,
                parent_order_id=101,
                tp_order_id=102,
                sl_order_id=103,
                entry_filled=False,
                signal_bar_ts=start + 2 * 60_000,
                simulated=False,
            )
            runner.state.flip_locks = [loop.TsFlipLock(exit_ts=start, stop_side="long")]
            loop.save_state(runner.state)
            original = runner._restore_runtime_state

            def wrapped() -> None:
                self.world.restores += 1
                runner.state.open = None
                runner.state.flip_locks = []
                original()

            runner._restore_runtime_state = wrapped  # type: ignore[method-assign]

        with self.assertLogs("ib_paper_loop", level="INFO") as logs:
            runner = self._run(
                place_orders=True,
                drop="socket",
                signal_bar=True,
                prepare=prepare,
            )
        text = "\n".join(logs.output)
        self.assertIn("Disconnect detected", text)
        self.assertIn("Reconnect attempt 1 to 127.0.0.1:4002 clientId=17", text)
        self.assertIn("Reconnect succeeded", text)
        self.assertIn("not placing a duplicate", text)
        self.assertGreaterEqual(self.world.restores, 1)
        self.assertEqual(self.world.placed, [])
        self.assertEqual(placed, [])
        self.assertEqual(
            self.world.connect_args,
            [("127.0.0.1", 4002, 17, False), ("127.0.0.1", 4002, 17, False)],
        )
        self.assertGreaterEqual(self.world.open_order_requests, 1)
        assert runner.state.open is not None
        self.assertEqual(runner.state.open.parent_order_id, 101)
        self.assertEqual(runner.state.open.tp_order_id, 102)
        self.assertEqual(runner.state.open.sl_order_id, 103)
        self.assertFalse(runner.state.open.entry_filled)
        self.assertEqual(runner.state.closed_count, 0)
        self.assertEqual(runner.state.equity, 12345.5)
        self.assertTrue(
            any(lock.exit_ts == self.start and lock.stop_side == "long" for lock in runner.state.flip_locks)
        )
        decided = len(runner.bars) - 2
        # Short warmup buffer cannot satisfy EMA100 ready; hybrid yields no signal here.
        again = loop.evaluate_bar(runner.bars, decided, runner.cfg.filters, "both", None, 3.5)
        self.assertIsNone(again.signal)
        self.assertEqual(runner._last_processed_ts, self.start + 120_000)

    def test_sigterm_during_reconnect_stops(self) -> None:
        before = signal.getsignal(signal.SIGTERM)
        with self.assertLogs("ib_paper_loop", level="INFO") as logs:
            runner = self._run(place_orders=True, drop="socket", sigterm=True, emit_bar=False)
        text = "\n".join(logs.output)
        self.assertIn("Disconnect detected", text)
        self.assertIn("Reconnect attempt 1 to 127.0.0.1:4002 clientId=17", text)
        self.assertIn("Signal received — shutting down", text)
        self.assertNotIn("Reconnect succeeded", text)
        self.assertEqual(len(self.world.connect_args), 1)
        self.assertEqual(self.world.connect_args[0][:3], ("127.0.0.1", 4002, 17))
        self.assertEqual(self.world.waits, [1.0])
        self.assertTrue(runner._stopping)
        self.assertEqual(self.world.placed, [])
        self.assertEqual(signal.getsignal(signal.SIGTERM), before)

    def test_live_port_is_still_refused(self) -> None:
        loop.refuse_live(4002, False)
        loop.refuse_live(4001, True)
        with self.assertRaises(SystemExit):
            loop.refuse_live(7496, False)
        before = signal.getsignal(signal.SIGTERM)
        runner = loop.PaperLoop(
            loop.Config(ibHost="127.0.0.1", ibPort=4001, clientId=17, allowLive=False),
            place_orders=True,
            dry_run=False,
        )

        def fail() -> None:
            raise AssertionError("IB constructor")

        runner._make_ib = fail  # type: ignore[method-assign]
        runner._wait = lambda seconds: None  # type: ignore[method-assign]
        with self.assertRaisesRegex(SystemExit, "Refusing port 4001"):
            runner.run_forever()
        self.assertEqual(self.world.connect_args, [])
        self.assertFalse(loop.STATE_PATH.exists())
        self.assertEqual(signal.getsignal(signal.SIGTERM), before)


if __name__ == "__main__":
    unittest.main()

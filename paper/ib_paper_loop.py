#!/usr/bin/env python3
"""
IBKR Paper Trading loop for MNQ 1-minute impulse strategy.

Architecture:
  - Persistent IB Gateway / TWS connection (Paper socket, default 4002)
  - One-time historical warmup (1m bars) for SMA / EMA / volume
  - Live 1m stream via reqHistoricalData(..., keepUpToDate=True)
    (reqRealTimeBars is 5-second only; keepUpToDate is the 1m path for MNQ)
  - On each *completed* bar: rolling indicators → signal / EMA tighten → orders
  - Never re-downloads full history every minute

Safety:
  - Refuses live-looking ports 4001 / 7496 unless allowLive / --allow-live
  - --dry-run (default): log signals, no orders
  - --place-orders: submit Paper limit + bracket (still refuses live ports)
  - maxContracts defaults to 1

Usage (Windows, Gateway Paper open on 4002):
  py -3 paper/ib_paper_loop.py --dry-run
  py -3 paper/ib_paper_loop.py --place-orders
  Ctrl+C to stop (cancel open entry optional; brackets left for kill-switch docs)
"""
from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

LIVE_PORTS = {7496, 4001}
PAPER_DIR = Path(__file__).resolve().parent
STATE_PATH = PAPER_DIR / "state.json"
TRADES_PATH = PAPER_DIR / "trades.jsonl"
UTC = timezone.utc


def _chicago_tz() -> ZoneInfo:
    try:
        return ZoneInfo("America/Chicago")
    except ZoneInfoNotFoundError as exc:
        raise SystemExit(
            "Missing timezone data for America/Chicago. On Windows run: "
            "py -3 -m pip install --user tzdata"
        ) from exc


CHICAGO = _chicago_tz()

Side = Literal["long", "short"]
Log = logging.getLogger("ib_paper_loop")


# ---------------------------------------------------------------------------
# Config / state
# ---------------------------------------------------------------------------


@dataclass
class Filters:
    bodyRatio: float = 0.45
    minBody: float = 2.0
    volLen: int = 15
    volMult: float = 1.2


@dataclass
class Config:
    mode: str = "ib-paper"
    ibHost: str = "127.0.0.1"
    ibPort: int = 4002
    clientId: int = 17
    allowLive: bool = False
    symbol: str = "MNQ"
    exchange: str = "CME"
    currency: str = "USD"
    filters: Filters = field(default_factory=Filters)
    roundTripFeeUsd: float = 1.6
    pointValue: float = 2.0
    startingEquity: float = 10_000.0
    maxContracts: int = 1
    side: str = "both"  # long | short | both
    placeOrders: bool = False
    warmupBars: int = 400
    limitOffsetTicks: float = 0.0  # 0 = limit at bar close; MNQ tick=0.25


def load_config() -> Config:
    raw: dict[str, Any] = {}
    for name in ("config.json", "config.example.json"):
        path = PAPER_DIR / name
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
            break
    fraw = raw.get("filters") or {}
    filters = Filters(
        bodyRatio=float(fraw.get("bodyRatio", 0.45)),
        minBody=float(fraw.get("minBody", 2)),
        volLen=int(fraw.get("volLen", 15)),
        volMult=float(fraw.get("volMult", 1.2)),
    )
    return Config(
        mode=str(raw.get("mode", "ib-paper")),
        ibHost=str(raw.get("ibHost", "127.0.0.1")),
        ibPort=int(raw.get("ibPort", 4002)),
        clientId=int(raw.get("clientId", 17)),
        allowLive=bool(raw.get("allowLive", False)),
        symbol=str(raw.get("symbol", "MNQ")),
        exchange=str(raw.get("exchange", "CME")),
        currency=str(raw.get("currency", "USD")),
        filters=filters,
        roundTripFeeUsd=float(raw.get("roundTripFeeUsd", 1.6)),
        pointValue=float(raw.get("pointValue", 2)),
        startingEquity=float(raw.get("startingEquity", 10_000)),
        maxContracts=max(1, int(raw.get("maxContracts", 1))),
        side=str(raw.get("side", "both")),
        placeOrders=bool(raw.get("placeOrders", False)),
        warmupBars=max(50, int(raw.get("warmupBars", 400))),
        limitOffsetTicks=float(raw.get("limitOffsetTicks", 0)),
    )


@dataclass
class Bar:
    ts: int  # epoch ms (bar open time, UTC)
    o: float
    h: float
    l: float
    c: float
    v: float


@dataclass
class OpenTrade:
    side: Side
    entry: float
    stop: float
    target: float
    risk: float
    entry_ts: int
    qty: int
    parent_order_id: Optional[int] = None
    tp_order_id: Optional[int] = None
    sl_order_id: Optional[int] = None
    tightened: bool = False
    entry_filled: bool = False


@dataclass
class RuntimeState:
    equity: float = 10_000.0
    peak_equity: float = 10_000.0
    last_bar_ts: Optional[int] = None
    open: Optional[OpenTrade] = None
    closed_count: int = 0
    total_fees: float = 0.0
    contract_local: str = ""
    contract_con_id: int = 0


def load_state(cfg: Config) -> RuntimeState:
    if not STATE_PATH.exists():
        return RuntimeState(equity=cfg.startingEquity, peak_equity=cfg.startingEquity)
    try:
        raw = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return RuntimeState(equity=cfg.startingEquity, peak_equity=cfg.startingEquity)
    open_raw = raw.get("open")
    open_trade = None
    if isinstance(open_raw, dict) and open_raw.get("side") in ("long", "short"):
        open_trade = OpenTrade(
            side=open_raw["side"],
            entry=float(open_raw["entry"]),
            stop=float(open_raw["stop"]),
            target=float(open_raw["target"]),
            risk=float(open_raw["risk"]),
            entry_ts=int(open_raw.get("entry_ts", 0)),
            qty=int(open_raw.get("qty", 1)),
            parent_order_id=open_raw.get("parent_order_id"),
            tp_order_id=open_raw.get("tp_order_id"),
            sl_order_id=open_raw.get("sl_order_id"),
            tightened=bool(open_raw.get("tightened", False)),
            entry_filled=bool(open_raw.get("entry_filled", False)),
        )
    return RuntimeState(
        equity=float(raw.get("equity", cfg.startingEquity)),
        peak_equity=float(raw.get("peak_equity", cfg.startingEquity)),
        last_bar_ts=raw.get("last_bar_ts"),
        open=open_trade,
        closed_count=int(raw.get("closed_count", 0)),
        total_fees=float(raw.get("total_fees", 0)),
        contract_local=str(raw.get("contract_local", "")),
        contract_con_id=int(raw.get("contract_con_id", 0)),
    )


def save_state(state: RuntimeState) -> None:
    payload: dict[str, Any] = {
        "equity": state.equity,
        "peak_equity": state.peak_equity,
        "last_bar_ts": state.last_bar_ts,
        "closed_count": state.closed_count,
        "total_fees": state.total_fees,
        "contract_local": state.contract_local,
        "contract_con_id": state.contract_con_id,
        "updated_at": datetime.now(tz=UTC).isoformat(),
        "open": None,
    }
    if state.open:
        payload["open"] = asdict(state.open)
    STATE_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def append_trade(record: dict[str, Any]) -> None:
    with TRADES_PATH.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------------------
# Indicators (match lib/ema.ts + strategy-script SMA)
# ---------------------------------------------------------------------------


def sma_at(values: list[float], index: int, length: int) -> float:
    if length < 1 or index < 0:
        return 0.0
    start = max(0, index - length + 1)
    window = values[start : index + 1]
    return sum(window) / len(window) if window else 0.0


def ema_series(values: list[float], length: int) -> list[Optional[float]]:
    """Match lib/ema.ts: SMA seed at index length-1, then EMA."""
    out: list[Optional[float]] = [None] * len(values)
    period = int(length)
    if period < 1 or len(values) < period:
        return out
    seed = sum(values[:period]) / period
    out[period - 1] = seed
    weight = 2.0 / (period + 1)
    prev = seed
    for i in range(period, len(values)):
        prev = values[i] * weight + prev * (1.0 - weight)
        out[i] = prev
    return out


def chicago_hour(ts_ms: int) -> int:
    dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=UTC).astimezone(CHICAGO)
    return dt.hour


def session_ok(ts_ms: int) -> bool:
    h = chicago_hour(ts_ms)
    return 9 <= h <= 21


# ---------------------------------------------------------------------------
# Strategy (mirror buildLong / buildShort)
# ---------------------------------------------------------------------------


@dataclass
class Signal:
    side: Side
    stop: float
    target: float
    risk: float
    entry: float


@dataclass
class EvalResult:
    signal: Optional[Signal] = None
    tighten_target: Optional[float] = None  # 1R when EMA condition met


def evaluate_bar(
    bars: list[Bar],
    index: int,
    filters: Filters,
    side_mode: str,
    open_trade: Optional[OpenTrade],
) -> EvalResult:
    bar = bars[index]
    closes = [b.c for b in bars]
    volumes = [b.v for b in bars]
    ema5_list = ema_series(closes, 5)
    ema5 = ema5_list[index]
    avg_vol = sma_at(volumes, index, filters.volLen)

    # Manage open: EMA tighten to 1R
    if open_trade is not None and ema5 is not None:
        if open_trade.side == "long" and bar.c < ema5 and not open_trade.tightened:
            return EvalResult(tighten_target=open_trade.entry + open_trade.risk)
        if open_trade.side == "short" and bar.c > ema5 and not open_trade.tightened:
            return EvalResult(tighten_target=open_trade.entry - open_trade.risk)
        return EvalResult()

    if open_trade is not None:
        return EvalResult()

    if not session_ok(bar.ts):
        return EvalResult()

    body = abs(bar.c - bar.o)
    span = max(bar.h - bar.l, 0.25)
    ratio_ok = (body / span) >= filters.bodyRatio
    body_ok = body >= filters.minBody
    vol_ok = bar.v > avg_vol * filters.volMult
    if not (ratio_ok and body_ok and vol_ok):
        return EvalResult()

    want_long = side_mode in ("long", "both") and bar.c > bar.o
    want_short = side_mode in ("short", "both") and bar.c < bar.o

    # If both somehow qualify (shouldn't on same bar), prefer long.
    if want_long:
        risk = max(bar.c - bar.l, 1.0)
        return EvalResult(
            signal=Signal(
                side="long",
                stop=bar.l,
                target=bar.c + risk * 2,
                risk=risk,
                entry=bar.c,
            )
        )
    if want_short:
        risk = max(bar.h - bar.c, 1.0)
        return EvalResult(
            signal=Signal(
                side="short",
                stop=bar.h,
                target=bar.c - risk * 2,
                risk=risk,
                entry=bar.c,
            )
        )
    return EvalResult()


# ---------------------------------------------------------------------------
# IB helpers
# ---------------------------------------------------------------------------


def refuse_live(port: int, allow_live: bool) -> None:
    if port in LIVE_PORTS and not allow_live:
        raise SystemExit(
            f"Refusing port {port} (live-looking). Use Gateway Paper 4002 / TWS Paper 7497, "
            "or pass --allow-live / allowLive:true (not recommended)."
        )


def qualify_front_mnq(ib: Any, cfg: Config) -> Any:
    from ib_insync import Future  # type: ignore

    contract = Future(
        symbol=cfg.symbol,
        lastTradeDateOrContractMonth="",
        exchange=cfg.exchange,
        currency=cfg.currency,
    )
    details = ib.reqContractDetails(contract)
    if not details:
        # Fallback: try ContFuture then GLOBEX for diagnose
        raise RuntimeError(
            f"No contract details for {cfg.symbol} on {cfg.exchange}. "
            "Check CME market data / paper permissions."
        )
    today = date.today().strftime("%Y%m%d")
    eligible = [
        d
        for d in details
        if (d.contract.lastTradeDateOrContractMonth or "") >= today
    ]
    pool = eligible or list(details)
    pool.sort(key=lambda d: d.contract.lastTradeDateOrContractMonth or "")
    front = pool[0].contract
    qualified = ib.qualifyContracts(front)
    if not qualified:
        raise RuntimeError(f"qualifyContracts failed for {front}")
    return qualified[0]


def ib_bar_to_bar(b: Any) -> Bar:
    # ib_insync BarData.date may be datetime or string
    dt = b.date
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        ts_ms = int(dt.timestamp() * 1000)
    else:
        # string like '20261023 22:15:00' America/New_York often — parse as UTC-ish via IB
        # formatDate=2 returns UTC string; we request formatDate=1 (datetime objects)
        ts_ms = int(time.time() * 1000)
    return Bar(
        ts=ts_ms,
        o=float(b.open),
        h=float(b.high),
        l=float(b.low),
        c=float(b.close),
        v=float(b.volume) if b.volume == b.volume else 0.0,  # NaN guard
    )


def round_to_tick(price: float, tick: float = 0.25) -> float:
    return round(price / tick) * tick


# ---------------------------------------------------------------------------
# Loop
# ---------------------------------------------------------------------------


class PaperLoop:
    def __init__(self, cfg: Config, place_orders: bool, dry_run: bool) -> None:
        self.cfg = cfg
        self.place_orders = place_orders and not dry_run
        self.dry_run = dry_run or not place_orders
        self.state = load_state(cfg)
        self.bars: list[Bar] = []
        self.ib: Any = None
        self.contract: Any = None
        self._hist_bars: Any = None
        self._stopping = False
        self._last_processed_ts: Optional[int] = None
        self._tick = 0.25

    def connect(self) -> None:
        from ib_insync import IB  # type: ignore

        refuse_live(self.cfg.ibPort, self.cfg.allowLive)
        self.ib = IB()
        Log.info(
            "Connecting %s:%s clientId=%s place_orders=%s dry_run=%s",
            self.cfg.ibHost,
            self.cfg.ibPort,
            self.cfg.clientId,
            self.place_orders,
            self.dry_run,
        )
        self.ib.connect(
            self.cfg.ibHost,
            self.cfg.ibPort,
            clientId=self.cfg.clientId,
            readonly=not self.place_orders,
        )
        accounts = self.ib.managedAccounts()
        Log.info("Managed accounts: %s", accounts)
        self.contract = qualify_front_mnq(self.ib, self.cfg)
        self.state.contract_local = getattr(self.contract, "localSymbol", "") or ""
        self.state.contract_con_id = int(getattr(self.contract, "conId", 0) or 0)
        Log.info(
            "Contract %s conId=%s expiry=%s exchange=%s mult=%s",
            self.state.contract_local,
            self.state.contract_con_id,
            self.contract.lastTradeDateOrContractMonth,
            self.contract.exchange,
            self.contract.multiplier,
        )
        save_state(self.state)

    def warmup_and_stream(self) -> None:
        """Fetch historical 1m once, then keepUpToDate for completed-bar events.

        Choice: keepUpToDate historical (not reqRealTimeBars).
        Real-time bars from IB are 5-second aggregates; 1-minute keepUpToDate
        matches the backtest bar size and fires hasNewBar on each minute close.
        """
        assert self.ib and self.contract
        duration = "2 D"
        Log.info(
            "Requesting historical 1m warmup duration=%s whatToShow=TRADES useRTH=False keepUpToDate=True",
            duration,
        )
        self._hist_bars = self.ib.reqHistoricalData(
            self.contract,
            endDateTime="",
            durationStr=duration,
            barSizeSetting="1 min",
            whatToShow="TRADES",
            useRTH=False,
            formatDate=1,
            keepUpToDate=True,
        )
        self.ib.sleep(3)
        self.bars = [ib_bar_to_bar(b) for b in self._hist_bars]

        if not self.bars:
            Log.warning(
                "keepUpToDate returned 0 bars — retrying static historical (no stream) then re-subscribe"
            )
            try:
                self.ib.cancelHistoricalData(self._hist_bars)
            except Exception:  # noqa: BLE001
                pass
            self.ib.sleep(1)
            static = self.ib.reqHistoricalData(
                self.contract,
                endDateTime="",
                durationStr=duration,
                barSizeSetting="1 min",
                whatToShow="TRADES",
                useRTH=False,
                formatDate=1,
                keepUpToDate=False,
            )
            self.ib.sleep(2)
            self.bars = [ib_bar_to_bar(b) for b in static]
            if self.bars:
                # Re-subscribe keepUpToDate for live updates (may still fail on Error 162)
                self._hist_bars = self.ib.reqHistoricalData(
                    self.contract,
                    endDateTime="",
                    durationStr="1800 S",
                    barSizeSetting="1 min",
                    whatToShow="TRADES",
                    useRTH=False,
                    formatDate=1,
                    keepUpToDate=True,
                )
                self.ib.sleep(2)
                live = [ib_bar_to_bar(b) for b in self._hist_bars]
                if live:
                    # merge by ts
                    by_ts = {b.ts: b for b in self.bars}
                    for b in live:
                        by_ts[b.ts] = b
                    self.bars = [by_ts[k] for k in sorted(by_ts)]

        Log.info(
            "Warmup loaded %s bars; last ts=%s (%s CT hour=%s)",
            len(self.bars),
            self.bars[-1].ts if self.bars else None,
            datetime.fromtimestamp(self.bars[-1].ts / 1000, tz=CHICAGO).isoformat()
            if self.bars
            else "-",
            chicago_hour(self.bars[-1].ts) if self.bars else "-",
        )
        if not self.bars:
            raise RuntimeError(
                "No 1m historical bars from IB (Error 162 common cause: another TWS/Gateway "
                "session on a different IP is using this username's market data). "
                "Log out other TWS/Gateway/mobile trading sessions, wait ~1 minute, retry. "
                "Weekend: equity-index futures are usually closed Fri–Sun evening CT."
            )
        completed_idx = max(0, len(self.bars) - 2) if len(self.bars) >= 2 else 0
        self._heartbeat_eval(completed_idx, source="warmup-completed", allow_order=False)
        self._last_processed_ts = self.bars[completed_idx].ts
        if self._hist_bars is not None:
            self._hist_bars.updateEvent += self._on_bar_update

    def _on_bar_update(self, bars: Any, has_new_bar: bool) -> None:
        if self._stopping:
            return
        try:
            self.bars = [ib_bar_to_bar(b) for b in bars]
            if not has_new_bar:
                return
            # bars[-1] is the new incomplete bar; bars[-2] just completed
            if len(self.bars) < 2:
                return
            idx = len(self.bars) - 2
            completed = self.bars[idx]
            if self._last_processed_ts is not None and completed.ts <= self._last_processed_ts:
                return
            self._last_processed_ts = completed.ts
            self.state.last_bar_ts = completed.ts
            self._heartbeat_eval(idx, source="stream", allow_order=True)
            save_state(self.state)
        except Exception:  # noqa: BLE001
            Log.exception("Error in bar update handler")

    def _heartbeat_eval(self, index: int, source: str, allow_order: bool) -> None:
        bar = self.bars[index]
        ct = datetime.fromtimestamp(bar.ts / 1000, tz=CHICAGO)
        result = evaluate_bar(
            self.bars,
            index,
            self.cfg.filters,
            self.cfg.side,
            self.state.open,
        )
        pos = "flat" if self.state.open is None else f"{self.state.open.side}@{self.state.open.entry}"
        Log.info(
            "BAR %s %s O=%.2f H=%.2f L=%.2f C=%.2f V=%.0f session=%s pos=%s",
            source,
            ct.strftime("%Y-%m-%d %H:%M %Z"),
            bar.o,
            bar.h,
            bar.l,
            bar.c,
            bar.v,
            session_ok(bar.ts),
            pos,
        )

        # Sync open position with IB if we think we are in a trade
        if self.state.open and self.place_orders:
            self._sync_position_from_ib()

        if result.tighten_target is not None and self.state.open:
            new_tp = round_to_tick(result.tighten_target, self._tick)
            Log.info(
                "TIGHTEN %s target %.2f -> %.2f (1R)",
                self.state.open.side,
                self.state.open.target,
                new_tp,
            )
            if allow_order and self.place_orders:
                self._modify_take_profit(new_tp)
            self.state.open.target = new_tp
            self.state.open.tightened = True
            return

        if result.signal is None:
            return

        sig = result.signal
        Log.info(
            "SIGNAL %s entry=%.2f stop=%.2f target=%.2f risk=%.2f dry_run=%s",
            sig.side,
            sig.entry,
            sig.stop,
            sig.target,
            sig.risk,
            self.dry_run or not allow_order,
        )
        if not allow_order or self.dry_run or not self.place_orders:
            Log.info("Order skipped (dry-run / no place-orders / warmup)")
            return
        if self.state.open is not None:
            Log.info("Already in position — skip new signal")
            return
        self._place_bracket(sig)

    def _ib_position_qty(self) -> float:
        assert self.ib and self.contract
        total = 0.0
        for p in self.ib.positions():
            if p.contract.conId == self.contract.conId:
                total += float(p.position)
        return total

    def _sync_position_from_ib(self) -> None:
        """If brackets filled / stopped, clear local open and log trade."""
        if not self.state.open:
            return
        qty = self._ib_position_qty()
        # Still holding
        if (self.state.open.side == "long" and qty > 0) or (
            self.state.open.side == "short" and qty < 0
        ):
            self.state.open.entry_filled = True
            return
        # Flat while we thought open → closed (or entry never filled / cancelled)
        if abs(qty) < 1e-9 and self.state.open.entry_filled:
            Log.info("Position flat on IB — booking close for accounting")
            self._book_close_approx()
        elif abs(qty) < 1e-9 and not self.state.open.entry_filled:
            # Check if parent cancelled / expired without fill
            Log.info("No position and entry not filled — clearing local open state")
            self.state.open = None

    def _book_close_approx(self) -> None:
        """Accounting-only close using last bar mid; IB paper has its own P&L."""
        if not self.state.open or not self.bars:
            return
        ot = self.state.open
        exit_px = self.bars[-1].c
        sign = 1 if ot.side == "long" else -1
        points = (exit_px - ot.entry) * sign
        pnl = points * self.cfg.pointValue * ot.qty - self.cfg.roundTripFeeUsd
        self.state.equity += pnl
        self.state.peak_equity = max(self.state.peak_equity, self.state.equity)
        self.state.closed_count += 1
        self.state.total_fees += self.cfg.roundTripFeeUsd
        append_trade(
            {
                "side": ot.side,
                "entry": ot.entry,
                "exit": exit_px,
                "stop": ot.stop,
                "target": ot.target,
                "risk": ot.risk,
                "qty": ot.qty,
                "pnl_usd_acct": pnl,
                "fee_usd": self.cfg.roundTripFeeUsd,
                "entry_ts": ot.entry_ts,
                "exit_ts": self.bars[-1].ts,
                "tightened": ot.tightened,
                "note": "approx close from IB flat detect",
            }
        )
        Log.info(
            "CLOSED approx %s entry=%.2f exit=%.2f pnl_acct=$%.2f equity=$%.2f",
            ot.side,
            ot.entry,
            exit_px,
            pnl,
            self.state.equity,
        )
        self.state.open = None

    def _place_bracket(self, sig: Signal) -> None:
        from ib_insync import LimitOrder, StopOrder  # type: ignore

        assert self.ib and self.contract
        qty = self.cfg.maxContracts
        action = "BUY" if sig.side == "long" else "SELL"
        exit_action = "SELL" if sig.side == "long" else "BUY"
        entry = round_to_tick(sig.entry + self.cfg.limitOffsetTicks * self._tick, self._tick)
        stop = round_to_tick(sig.stop, self._tick)
        target = round_to_tick(sig.target, self._tick)

        # Manual bracket: parent LMT + children TP LMT + SL STP (OCA)
        parent = LimitOrder(action, qty, entry)
        parent.orderId = self.ib.client.getReqId()
        parent.transmit = False
        parent.outsideRth = True
        parent.tif = "DAY"

        tp = LimitOrder(exit_action, qty, target)
        tp.orderId = self.ib.client.getReqId()
        tp.parentId = parent.orderId
        tp.transmit = False
        tp.outsideRth = True
        tp.tif = "GTC"

        sl = StopOrder(exit_action, qty, stop)
        sl.orderId = self.ib.client.getReqId()
        sl.parentId = parent.orderId
        sl.transmit = True  # last child transmits whole chain
        sl.outsideRth = True
        sl.tif = "GTC"

        oca = f"mnq-{parent.orderId}"
        tp.ocaGroup = oca
        tp.ocaType = 1
        sl.ocaGroup = oca
        sl.ocaType = 1

        Log.info(
            "PLACE bracket %s qty=%s lmt=%.2f tp=%.2f sl=%.2f ids=%s/%s/%s",
            action,
            qty,
            entry,
            target,
            stop,
            parent.orderId,
            tp.orderId,
            sl.orderId,
        )
        for order in (parent, tp, sl):
            self.ib.placeOrder(self.contract, order)

        self.state.open = OpenTrade(
            side=sig.side,
            entry=entry,
            stop=stop,
            target=target,
            risk=sig.risk,
            entry_ts=int(time.time() * 1000),
            qty=qty,
            parent_order_id=parent.orderId,
            tp_order_id=tp.orderId,
            sl_order_id=sl.orderId,
            tightened=False,
            entry_filled=False,
        )
        save_state(self.state)

    def _modify_take_profit(self, new_tp: float) -> None:
        assert self.ib and self.contract and self.state.open
        tp_id = self.state.open.tp_order_id
        if not tp_id:
            Log.warning("No tp_order_id to modify")
            return
        # Find open trade for TP
        for trade in self.ib.openTrades():
            if trade.order.orderId == tp_id:
                trade.order.lmtPrice = new_tp
                self.ib.placeOrder(self.contract, trade.order)
                Log.info("Modified TP order %s -> %.2f", tp_id, new_tp)
                return
        Log.warning("TP order %s not found in openTrades — may already filled", tp_id)

    def run_forever(self) -> None:
        assert self.ib
        Log.info("Loop running. Ctrl+C to stop. dry_run=%s place_orders=%s", self.dry_run, self.place_orders)

        def _handle_sig(_signum: int, _frame: Any) -> None:
            Log.info("Signal received — shutting down")
            self._stopping = True

        signal.signal(signal.SIGINT, _handle_sig)
        signal.signal(signal.SIGTERM, _handle_sig)

        deadline = None
        timeout_sec = getattr(self, "_timeout_sec", 0) or 0
        if timeout_sec > 0:
            deadline = time.time() + timeout_sec
            Log.info("Auto-stop in %ss", timeout_sec)

        while not self._stopping:
            if deadline is not None and time.time() >= deadline:
                Log.info("Timeout reached — stopping")
                self._stopping = True
                break
            self.ib.sleep(1)
            # Periodic position sync
            if self.place_orders and self.state.open:
                try:
                    self._sync_position_from_ib()
                    save_state(self.state)
                except Exception:  # noqa: BLE001
                    Log.exception("sync failed")

        Log.info("Disconnecting…")
        try:
            if self._hist_bars is not None:
                self.ib.cancelHistoricalData(self._hist_bars)
        except Exception:  # noqa: BLE001
            pass
        self.ib.disconnect()
        save_state(self.state)
        Log.info("Stopped. state=%s trades=%s", STATE_PATH, TRADES_PATH)


def parse_args() -> argparse.Namespace:
    cfg = load_config()
    p = argparse.ArgumentParser(description="MNQ IBKR Paper 1m impulse loop")
    p.add_argument("--host", default=cfg.ibHost)
    p.add_argument("--port", type=int, default=cfg.ibPort)
    p.add_argument("--client-id", type=int, default=cfg.clientId)
    p.add_argument("--allow-live", action="store_true", default=cfg.allowLive)
    p.add_argument(
        "--dry-run",
        action="store_true",
        default=not cfg.placeOrders,
        help="Log bars/signals only (default unless placeOrders true in config)",
    )
    p.add_argument(
        "--place-orders",
        action="store_true",
        default=False,
        help="Submit Paper limit+bracket orders (overrides dry-run)",
    )
    p.add_argument(
        "--max-bars",
        type=int,
        default=0,
        help="If >0, exit after this many *stream* completed bars (0=forever)",
    )
    p.add_argument(
        "--timeout-sec",
        type=int,
        default=0,
        help="If >0, exit after this many seconds (smoke tests)",
    )
    p.add_argument("--log-level", default="INFO")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    cfg = load_config()
    cfg.ibHost = args.host
    cfg.ibPort = args.port
    cfg.clientId = args.client_id
    cfg.allowLive = bool(args.allow_live)

    place = bool(args.place_orders)
    dry = bool(args.dry_run) and not place
    if place:
        dry = False

    try:
        from ib_insync import util  # type: ignore

        util.patchAsyncio()
    except ImportError:
        Log.error("ib_insync not installed. Run: py -3 -m pip install --user ib_insync")
        return 1

    loop = PaperLoop(cfg, place_orders=place, dry_run=dry)
    loop._timeout_sec = int(args.timeout_sec or 0)
    # Optional: auto-stop after N stream bars (for smoke)
    if args.max_bars > 0:
        orig_on = loop._on_bar_update
        counter = {"n": 0}

        def limited(bars: Any, has_new_bar: bool) -> None:
            orig_on(bars, has_new_bar)
            if has_new_bar:
                counter["n"] += 1
                Log.info("stream completed bars: %s / %s", counter["n"], args.max_bars)
                if counter["n"] >= args.max_bars:
                    loop._stopping = True

        loop._on_bar_update = limited  # type: ignore[method-assign]

    try:
        loop.connect()
        loop.warmup_and_stream()
        loop.run_forever()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        Log.exception("Fatal: %s", exc)
        if loop.ib and loop.ib.isConnected():
            loop.ib.disconnect()
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

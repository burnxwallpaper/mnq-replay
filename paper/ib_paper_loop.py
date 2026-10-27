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
  - Unfilled entry limit expires after ENTRY_LIMIT_EXPIRY_BARS completed 1m bars (default 2)
  - A working Paper entry stays tracked until the parent fills, the parent is cancelled,
    or that limit expires. An empty positions() snapshot is not a cancel (fills lag it).
  - maxContracts defaults to 1
  - EMA tighten to 1R revises the working TP limit in place. The modify
    sends an empty ocaGroup and omits ocaType. ocaType 0 is the text "0" on
    the wire, an OCA type revision (IB 10327) that cancels the working TP.
    10326 and 10327 are hard rejects: the live price and OCA stay put, and
    the log does not say Modified. The stop stays in the original OCA group.
    target/tightened update only after that modify is accepted.
  - Daytime flip lock (default 0, off): set above 0 to block opposite-side
    entries for that many completed 1m bars after a full stop. Same side stays
    allowed. Shared by long and short when side=both. Paper sockets only.

Usage (Windows, Gateway Paper open on 4002 — not live 4001/7496):
  py -3 paper/ib_paper_loop.py --dry-run --host 127.0.0.1 --port 4002
  py -3 paper/ib_paper_loop.py --place-orders --host 127.0.0.1 --port 4002
  py -3 paper/ib_paper_loop.py --place-orders --flip-lock-bars 15  # optional; default is 0 (off)
  Ctrl+C / SIGTERM to stop (brackets left for the kill-switch docs)

If the Gateway API drops, the loop reconnects the same host, port, and clientId
with capped backoff until Ctrl+C / SIGTERM. It re-qualifies MNQ, resubscribes
to 1m keepUpToDate, and reloads state.json so an open bracket is not sent twice.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time
from copy import copy
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

LIVE_PORTS = {7496, 4001}
# ib_insync: disconnectedEvent fires from client.apiEnd when a ready socket drops
# (and from IB.disconnect while still connected). isConnected() is client.isReady().
# IB.sleep is util.sleep and does not raise on a peer close, so the loop has to
# watch the event and isConnected(). These errorEvent codes mean the API/Gateway
# link is gone. Market-data farm notices (2103 and the like) recover in place.
_LOST_CONNECTION_CODES = frozenset({1100, 502, 504, 1300})
# Unfilled entry Limit: cancel after this many *completed* 1m bars after the signal bar.
ENTRY_LIMIT_EXPIRY_BARS = 2
# Dead parent, and only these. "Inactive" is left alone: a bracket can sit there
# before the transmitting child, and a reject still dies on the entry-limit timer.
_ENTRY_CANCEL_STATUSES = frozenset({"cancelled", "apicancelled"})
# ib_insync.util.UNSET_INTEGER. Client.send writes this as an empty field.
# ocaType 0 is not empty: placeOrder writes the text "0", which revises a
# live type-1 OCA order. Paper answers with 10327 and cancels that order.
_OCA_TYPE_UNSET = 2**31 - 1
# A modify that names an OCA group (10326) or sends an OCA type (10327) is
# a revision. These codes mean IB did not apply the new limit. 2109 is not
# here: that warning means the price change was processed and the existing
# OCA group was left alone.
_TP_MODIFY_REJECT_CODES = frozenset({
    103,
    104,
    105,
    106,
    107,
    109,
    110,
    201,
    202,
    203,
    321,
    10147,
    10148,
    10326,
    10327,
})
# Paper Gateway rejects 10326/10327 within a few milliseconds. Wait long
# enough to see that before recording the 1R target locally.
_TP_MODIFY_ACK_SEC = 1.0


def reconnect_backoff_seconds(attempt: int) -> float:
    """Delay before reconnect attempt N (1-based): 1s, 2s, 4s, … capped at 30s."""
    if attempt < 1:
        return 1.0
    # attempt 6 is 32s before the cap. Don't build 2**n once n no longer fits a float.
    if attempt >= 6:
        return 30.0
    return float(2 ** (attempt - 1))


PAPER_DIR = Path(__file__).resolve().parent
if str(PAPER_DIR) not in sys.path:
    sys.path.insert(0, str(PAPER_DIR))

from flip_lock import (  # noqa: E402
    DEFAULT_FLIP_LOCK_BARS,
    TsFlipLock,
    arm_stop_flip_lock,
    bar_covering_ts,
    effective_flip_lock_bars,
    exit_reason_from_order_fills,
    normalize_flip_lock_bars,
    prune_flip_locks,
    resolve_entry_limit_fill,
    resolve_exit_fill,
    resolve_flip_lock_bars,
    signal_flip_locked,
)

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
    bodyRatio: float = 0.2
    minBody: float = 2.0
    volLen: int = 10
    volMult: float = 0.2


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
    rewardMultiple: float = 30.0  # initial TP in R; EMA may tighten to 1R
    entryLimitExpiryBars: int = 2  # cancel unfilled entry after N completed 1m bars
    # Opposite-side lock after a full stop. 0 matches the web daytime default (off).
    flipLockBars: int = DEFAULT_FLIP_LOCK_BARS


def load_config() -> Config:
    raw: dict[str, Any] = {}
    for name in ("config.json", "config.example.json"):
        path = PAPER_DIR / name
        if path.exists():
            raw = json.loads(path.read_text(encoding="utf-8"))
            break
    fraw = raw.get("filters") or {}
    filters = Filters(
        bodyRatio=float(fraw.get("bodyRatio", 0.2)),
        minBody=float(fraw.get("minBody", 2)),
        volLen=int(fraw.get("volLen", 10)),
        volMult=float(fraw.get("volMult", 0.2)),
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
        rewardMultiple=float(raw.get("rewardMultiple", 30)),
        entryLimitExpiryBars=max(1, int(raw.get("entryLimitExpiryBars", ENTRY_LIMIT_EXPIRY_BARS))),
        flipLockBars=normalize_flip_lock_bars(raw["flipLockBars"])
        if "flipLockBars" in raw
        else DEFAULT_FLIP_LOCK_BARS,
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
    signal_bar_ts: int = 0  # completed bar that generated the signal
    bars_waited: int = 0  # completed bars after signal while still unfilled
    simulated: bool = False  # dry-run virtual book; never an IB order
    # True only after positions() has shown this side. Order-status fills can
    # arrive while that snapshot is still flat; flat + not seen is not an exit.
    position_seen: bool = False


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
    flip_locks: list[TsFlipLock] = field(default_factory=list)


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
            signal_bar_ts=int(open_raw.get("signal_bar_ts", 0) or 0),
            bars_waited=int(open_raw.get("bars_waited", 0) or 0),
            simulated=bool(open_raw.get("simulated", False)),
            # Older files set entry_filled only after positions() showed the side.
            position_seen=(
                bool(open_raw["position_seen"])
                if "position_seen" in open_raw
                else bool(open_raw.get("entry_filled", False))
            ),
        )
    locks: list[TsFlipLock] = []
    for item in raw.get("flip_locks") or []:
        if not isinstance(item, dict):
            continue
        side = item.get("stop_side")
        if side not in ("long", "short"):
            continue
        try:
            exit_ts = int(item.get("exit_ts") or 0)
        except (TypeError, ValueError):
            continue
        if exit_ts <= 0:
            continue
        locks.append(TsFlipLock(exit_ts=exit_ts, stop_side=str(side)))
    return RuntimeState(
        equity=float(raw.get("equity", cfg.startingEquity)),
        peak_equity=float(raw.get("peak_equity", cfg.startingEquity)),
        last_bar_ts=raw.get("last_bar_ts"),
        open=open_trade,
        closed_count=int(raw.get("closed_count", 0)),
        total_fees=float(raw.get("total_fees", 0)),
        contract_local=str(raw.get("contract_local", "")),
        contract_con_id=int(raw.get("contract_con_id", 0)),
        flip_locks=locks,
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
        "flip_locks": [asdict(lock) for lock in state.flip_locks],
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


# Session for NEW entries only (open trades still manage/exit anytime).
# SESSION_START=09:00 CT, SESSION_END=21:00 CT, no new entries in last 30 min → before 20:30 CT.
# Friday: no new entries from 14:45 CT onward (FRIDAY_ENTRY_CUTOFF=14:45).
SESSION_START_HOUR = 9
SESSION_END_HOUR = 21
ENTRY_CUTOFF_MINUTES_BEFORE_CLOSE = 30
FRIDAY_ENTRY_CUTOFF_MINUTES = 14 * 60 + 45  # 14:45 CT


def chicago_hour(ts_ms: int) -> int:
    dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=UTC).astimezone(CHICAGO)
    return dt.hour


def chicago_hm(ts_ms: int) -> tuple[int, int]:
    dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=UTC).astimezone(CHICAGO)
    return dt.hour, dt.minute


def session_ok(ts_ms: int) -> bool:
    dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=UTC).astimezone(CHICAGO)
    mins = dt.hour * 60 + dt.minute
    start = SESSION_START_HOUR * 60
    last_entry = SESSION_END_HOUR * 60 - ENTRY_CUTOFF_MINUTES_BEFORE_CLOSE
    if not (start <= mins < last_entry):
        return False
    # Monday=0 … Friday=4
    if dt.weekday() == 4 and mins >= FRIDAY_ENTRY_CUTOFF_MINUTES:
        return False
    return True


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
    reward_multiple: float = 30.0,
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
                target=bar.c + risk * reward_multiple,
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
                target=bar.c - risk * reward_multiple,
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


def replay_flip_locks(
    bars: list[Bar],
    filters: Filters,
    side_mode: str,
    flip_lock_bars: int,
    reward_multiple: float = 30.0,
    entry_limit_expiry_bars: int = ENTRY_LIMIT_EXPIRY_BARS,
) -> list[TsFlipLock]:
    """Rebuild stop locks from bars without placing orders.

    Uses one net position, matching the IB book (long and short offset). The last
    bar is treated as still forming and is not decided. A full stop arms the shared
    lock; a same-bar opposite signal is still allowed.
    """
    n = effective_flip_lock_bars(side_mode, flip_lock_bars)
    if n <= 0 or len(bars) < 2:
        return []
    locks: list[TsFlipLock] = []
    open_trade: Optional[OpenTrade] = None
    last = len(bars) - 2
    for index in range(last + 1):
        bar = bars[index]
        if open_trade is not None and open_trade.entry_filled:
            exit_fill = resolve_exit_fill(bar, open_trade.side, open_trade.stop, open_trade.target)
            if exit_fill is None:
                managed = evaluate_bar(
                    bars, index, filters, side_mode, open_trade, reward_multiple
                )
                if managed.tighten_target is not None and not open_trade.tightened:
                    open_trade.target = managed.tighten_target
                    open_trade.tightened = True
                continue
            _price, reason = exit_fill
            arm_stop_flip_lock(locks, n, bar.ts, open_trade.side, reason)
            open_trade = None
        elif open_trade is not None and not open_trade.entry_filled:
            if bar.ts <= open_trade.signal_bar_ts:
                continue
            fill = resolve_entry_limit_fill(bar, open_trade.side, open_trade.entry, open_trade.stop)
            if fill is not None:
                open_trade.entry = fill
                open_trade.entry_filled = True
                open_trade.entry_ts = bar.ts
                exit_fill = resolve_exit_fill(bar, open_trade.side, open_trade.stop, open_trade.target)
                if exit_fill is None:
                    continue
                _price, reason = exit_fill
                arm_stop_flip_lock(locks, n, bar.ts, open_trade.side, reason)
                open_trade = None
            else:
                waited = sum(1 for seen in bars[: index + 1] if seen.ts > open_trade.signal_bar_ts)
                open_trade.bars_waited = waited
                if waited >= entry_limit_expiry_bars:
                    open_trade = None
                continue

        if open_trade is not None:
            continue
        result = evaluate_bar(bars, index, filters, side_mode, None, reward_multiple)
        if result.signal is None:
            continue
        if signal_flip_locked(locks, bars, result.signal.side, index, n) is not None:
            continue
        sig = result.signal
        open_trade = OpenTrade(
            side=sig.side,
            entry=sig.entry,
            stop=sig.stop,
            target=sig.target,
            risk=sig.risk,
            entry_ts=bar.ts,
            qty=1,
            simulated=True,
            entry_filled=False,
            signal_bar_ts=bar.ts,
            bars_waited=0,
        )
    return locks


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
        self._disconnected = False
        self._reconnecting = False
        self._reconnect_attempt = 0
        self._deadline: Optional[float] = None
        self._signals_installed = False
        self._prev_sigint: Any = None
        self._prev_sigterm: Any = None
        self._timeout_sec = 0
        self._session_started = False
        self._ib_token: object = None
        self._lost_during_connect = False
        self._last_processed_ts: Optional[int] = None
        self._tp_modify_in_progress = False
        self._tick = 0.25
        self.flip_lock_bars = effective_flip_lock_bars(cfg.side, cfg.flipLockBars)
        if self.place_orders and self.state.open is not None and self.state.open.simulated:
            Log.info("Ignoring simulated dry-run position; Paper orders follow the Gateway book")
            self.state.open = None

    def _make_ib(self) -> Any:
        from ib_insync import IB  # type: ignore

        return IB()

    def connect(self) -> None:
        refuse_live(self.cfg.ibPort, self.cfg.allowLive)
        ib = self._make_ib()
        token = object()
        self._ib_token = token
        # Assign before connect() so a drop during the handshake is this session's.
        self.ib = ib

        def _from_this_session(*_args: object) -> None:
            if self._ib_token is not token or self.ib is not ib:
                return
            self._on_disconnected()

        def _on_error(
            req_id: object,
            error_code: object,
            error_string: object,
            contract: object = None,
            *_args: object,
        ) -> None:
            if self._ib_token is not token or self.ib is not ib:
                return
            self._on_ib_error(req_id, error_code, error_string, contract)

        ib.disconnectedEvent += _from_this_session
        ib.errorEvent += _on_error
        Log.info(
            "PAPER ONLY. Connecting %s:%s clientId=%s place_orders=%s dry_run=%s "
            "flipLockBars=%s effective=%s side=%s",
            self.cfg.ibHost,
            self.cfg.ibPort,
            self.cfg.clientId,
            self.place_orders,
            self.dry_run,
            self.cfg.flipLockBars,
            self.flip_lock_bars,
            self.cfg.side,
        )
        ib.connect(
            self.cfg.ibHost,
            self.cfg.ibPort,
            clientId=self.cfg.clientId,
            readonly=not self.place_orders,
        )
        accounts = ib.managedAccounts()
        Log.info("Managed accounts: %s", accounts)
        self.contract = qualify_front_mnq(ib, self.cfg)
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
        self._session_started = True

    def _on_disconnected(self, *_args: object) -> None:
        if self._stopping:
            return
        if self._reconnecting:
            # Warmup runs inside the connect attempt. Remember a drop, but do not
            # start a second reconnect from the event handler.
            if not self._lost_during_connect:
                Log.warning("Disconnect detected")
            self._lost_during_connect = True
            return
        self._note_disconnect(None)

    def _on_ib_error(
        self,
        req_id: object,
        error_code: object,
        error_string: object,
        contract: object = None,
        *_args: object,
    ) -> None:
        del req_id, contract
        try:
            code = int(error_code)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return
        if code not in _LOST_CONNECTION_CODES:
            return
        if self._stopping:
            return
        if self._reconnecting:
            if not self._lost_during_connect:
                Log.warning("Disconnect detected: IB error %s: %s", code, error_string)
            self._lost_during_connect = True
            return
        self._note_disconnect(f"IB error {code}: {error_string}")

    def _note_disconnect(self, detail: object) -> None:
        if self._stopping or self._disconnected:
            return
        self._disconnected = True
        if detail is None:
            Log.warning("Disconnect detected")
        else:
            Log.warning("Disconnect detected: %s", detail)

    def _ib_connected(self) -> bool:
        ib = self.ib
        if ib is None:
            return False
        try:
            return bool(ib.isConnected())
        except Exception:  # noqa: BLE001
            return False

    def _connection_failure(self, exc: BaseException) -> bool:
        return isinstance(exc, (ConnectionError, OSError, TimeoutError))

    def _cancel_stream(self) -> None:
        bars = self._hist_bars
        self._hist_bars = None
        if bars is None:
            return
        try:
            bars.updateEvent -= self._on_bar_update
        except Exception:  # noqa: BLE001
            pass
        ib = self.ib
        if ib is None:
            return
        try:
            if ib.isConnected():
                ib.cancelHistoricalData(bars)
        except Exception:  # noqa: BLE001
            Log.debug("cancelHistoricalData failed", exc_info=True)

    def _drop_session(self) -> None:
        """Detach the 1m stream and close the socket before a new connect."""
        self._cancel_stream()
        ib = self.ib
        self.ib = None
        if ib is None:
            return
        try:
            if ib.isConnected():
                ib.disconnect()
        except Exception:  # noqa: BLE001
            Log.exception("disconnect failed")

    def _restore_runtime_state(self) -> None:
        """Reload state.json so a bracket and flip locks survive the new session.

        A failed save keeps an in-memory working bracket instead of forgetting it
        and sending another one.
        """
        previous = self.state
        restored = load_state(self.cfg)
        if self.place_orders and restored.open is not None and restored.open.simulated:
            Log.info("Ignoring simulated dry-run position; Paper orders follow the Gateway book")
            restored.open = None
        memory_open = previous.open
        file_open = restored.open
        if file_open is None and memory_open is not None and not memory_open.simulated:
            restored.open = memory_open
        seen = {(lock.exit_ts, lock.stop_side) for lock in restored.flip_locks}
        for lock in previous.flip_locks:
            key = (lock.exit_ts, lock.stop_side)
            if key not in seen:
                restored.flip_locks.append(lock)
                seen.add(key)
        if not restored.contract_local:
            restored.contract_local = previous.contract_local
        if not restored.contract_con_id:
            restored.contract_con_id = previous.contract_con_id
        self.state = restored
        open_trade = self.state.open
        if open_trade is not None and not open_trade.simulated and open_trade.parent_order_id is not None:
            Log.info(
                "Restored open bracket side=%s parent=%s tp=%s sl=%s entry_filled=%s; "
                "not placing a duplicate",
                open_trade.side,
                open_trade.parent_order_id,
                open_trade.tp_order_id,
                open_trade.sl_order_id,
                open_trade.entry_filled,
            )

    def _refresh_open_orders(self) -> None:
        """Ask Gateway for this clientId's working orders before the next decision."""
        if not self.place_orders or self.ib is None:
            return
        req = getattr(self.ib, "reqOpenOrders", None)
        if not callable(req):
            return
        Log.info("Requesting open orders so an existing bracket is adopted")
        req()

    def _wait(self, seconds: float) -> None:
        """Sleep up to `seconds`, returning early on Ctrl+C / SIGTERM or the smoke timeout."""
        if seconds <= 0:
            return
        end = time.monotonic() + seconds
        while not self._stopping and not self._timed_out():
            remaining = end - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(0.2, remaining))

    def _timed_out(self) -> bool:
        deadline = self._deadline
        return deadline is not None and time.monotonic() >= deadline

    def _session_ready(self) -> bool:
        return (
            self.ib is not None
            and self._hist_bars is not None
            and not self._disconnected
            and self._ib_connected()
        )

    def _reconnect_session(self) -> bool:
        """Connect, restore state.json, and resubscribe. Retry until stop.

        Returns False when Ctrl+C, SIGTERM, or the smoke timeout ends the wait.
        """
        self._reconnecting = True
        try:
            while not self._stopping:
                if self._timed_out():
                    Log.info("Timeout reached — stopping")
                    self._stopping = True
                    return False
                if self._disconnected:
                    self._reconnect_attempt += 1
                    delay = reconnect_backoff_seconds(self._reconnect_attempt)
                    Log.warning(
                        "Reconnect attempt %s to %s:%s clientId=%s in %ss",
                        self._reconnect_attempt,
                        self.cfg.ibHost,
                        self.cfg.ibPort,
                        self.cfg.clientId,
                        delay,
                    )
                    self._wait(delay)
                    if self._stopping:
                        return False
                    if self._timed_out():
                        Log.info("Timeout reached — stopping")
                        self._stopping = True
                        return False
                try:
                    had_drop = self._disconnected
                    if had_drop:
                        try:
                            save_state(self.state)
                        except Exception:  # noqa: BLE001
                            Log.exception("Could not save state before reconnect")
                    self._drop_session()
                    self._lost_during_connect = False
                    self.connect()
                    if self._lost_during_connect or not self._ib_connected():
                        raise ConnectionError("Connection lost while starting the session")
                    self._restore_runtime_state()
                    self._refresh_open_orders()
                    self.warmup_and_stream()
                    if self._lost_during_connect or not self._ib_connected():
                        raise ConnectionError("Connection lost while starting the session")
                    if had_drop:
                        Log.info("Reconnect succeeded")
                    self._disconnected = False
                    self._reconnect_attempt = 0
                    return True
                except SystemExit:
                    raise
                except Exception:  # noqa: BLE001
                    Log.exception("Connect failed")
                    self._disconnected = True
            return False
        finally:
            self._reconnecting = False

    def warmup_and_stream(self) -> None:
        """Fetch historical 1m once, then keepUpToDate for completed-bar events.

        Choice: keepUpToDate historical (not reqRealTimeBars).
        Real-time bars from IB are 5-second aggregates; 1-minute keepUpToDate
        matches the backtest bar size and fires hasNewBar on each minute close.
        """
        self._cancel_stream()
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
        self._seed_flip_locks()
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

    def _seed_flip_locks(self) -> None:
        """Union warmup-bar stops with locks already stored in state.json."""
        if self.flip_lock_bars <= 0:
            self.state.flip_locks = []
            Log.info("Flip lock off (bars=%s side=%s)", self.cfg.flipLockBars, self.cfg.side)
            return
        seeded = replay_flip_locks(
            self.bars,
            self.cfg.filters,
            self.cfg.side,
            self.cfg.flipLockBars,
            self.cfg.rewardMultiple,
            self.cfg.entryLimitExpiryBars,
        )
        for lock in seeded:
            arm_stop_flip_lock(self.state.flip_locks, self.flip_lock_bars, lock.exit_ts, lock.stop_side, "stop")
        self.state.flip_locks = prune_flip_locks(self.state.flip_locks, self.bars, self.flip_lock_bars)
        Log.info(
            "Flip lock armed windows=%s (N=%s, shared long+short)",
            len(self.state.flip_locks),
            self.flip_lock_bars,
        )
        save_state(self.state)

    def _heartbeat_eval(self, index: int, source: str, allow_order: bool) -> None:
        bar = self.bars[index]
        ct = datetime.fromtimestamp(bar.ts / 1000, tz=CHICAGO)

        # Sync open position with IB if we think we are in a real trade.
        if self.state.open and self.place_orders:
            if self.state.open.simulated:
                Log.info("Dropping simulated position; Gateway is the Paper book")
                self.state.open = None
            else:
                self._sync_position_from_ib(index)

        # Dry-run virtual book: limit fill, expiry, stop/target. No orders.
        if not self.place_orders and self.state.open is not None:
            status = self._advance_simulated(index)
            if status in ("pending", "expired"):
                if self.state.open is None:
                    self._log_bar(source, ct, bar, "flat")
                else:
                    waited = self.state.open.bars_waited
                    expiry = self.cfg.entryLimitExpiryBars
                    self._log_bar(
                        source,
                        ct,
                        bar,
                        f"pending-{self.state.open.side}@{self.state.open.entry} waited={waited}/{expiry}",
                    )
                # An expired limit does not free this same bar for a new signal
                # (the web engine stays on the pending leg for that bar).
                return

        # Unfilled Paper entry: count completed bars after the signal bar.
        if self.place_orders and self.state.open and not self.state.open.entry_filled:
            waited = self._bars_since_signal(index)
            self.state.open.bars_waited = waited
            expiry = self.cfg.entryLimitExpiryBars
            pos = f"pending-{self.state.open.side}@{self.state.open.entry} waited={waited}/{expiry}"
            self._log_bar(source, ct, bar, pos)
            if waited >= expiry:
                self._cancel_unfilled_entry(
                    f"entry limit expired after {waited} completed 1m bar(s) "
                    f"(limit={expiry}; signal_bar_ts={self.state.open.signal_bar_ts})"
                )
                save_state(self.state)
            return

        # Pass open only when filled so EMA tighten does not run on a resting entry.
        open_for_eval = self.state.open if (self.state.open and self.state.open.entry_filled) else None
        result = evaluate_bar(
            self.bars,
            index,
            self.cfg.filters,
            self.cfg.side,
            open_for_eval,
            self.cfg.rewardMultiple,
        )
        pos = "flat" if self.state.open is None else f"{self.state.open.side}@{self.state.open.entry}"
        self._log_bar(source, ct, bar, pos)

        if result.tighten_target is not None and self.state.open and self.state.open.entry_filled:
            new_tp = round_to_tick(result.tighten_target, self._tick)
            Log.info(
                "TIGHTEN %s target %.2f -> %.2f (1R)",
                self.state.open.side,
                self.state.open.target,
                new_tp,
            )
            if self.place_orders and not self._modify_take_profit(new_tp):
                # IB still has the previous limit. Leaving tightened false
                # lets a later bar retry. Do not pretend the TP moved.
                Log.warning(
                    "TIGHTEN not applied %s IB target stays %.2f",
                    self.state.open.side,
                    self.state.open.target,
                )
                return
            self.state.open.target = new_tp
            self.state.open.tightened = True
            return

        if result.signal is None:
            return

        sig = result.signal
        blocked = signal_flip_locked(
            self.state.flip_locks,
            self.bars,
            sig.side,
            index,
            self.flip_lock_bars,
        )
        Log.info(
            "SIGNAL %s entry=%.2f stop=%.2f target=%.2f risk=%.2f dry_run=%s flip_lock=%s",
            sig.side,
            sig.entry,
            sig.stop,
            sig.target,
            sig.risk,
            self.dry_run or not allow_order,
            blocked is not None,
        )
        if blocked is not None:
            Log.info(
                "FLIP-LOCK block %s after %s stop (signal index %s, locked through index %s, N=%s)",
                sig.side,
                blocked.stop_side,
                index,
                blocked.until_bar,
                self.flip_lock_bars,
            )
            return
        if not allow_order:
            Log.info("Order skipped (warmup)")
            return
        if self.state.open is not None:
            Log.info("Already in position — skip new signal")
            return
        if not self.place_orders:
            self._open_simulated(sig, signal_bar_ts=bar.ts)
            Log.info("DRY-RUN virtual %s limit @ %.2f (no order sent)", sig.side, sig.entry)
            save_state(self.state)
            return
        self._place_bracket(sig, signal_bar_ts=bar.ts)

    def _log_bar(self, source: str, ct: datetime, bar: Bar, pos: str) -> None:
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

    def _advance_simulated(self, index: int) -> str:
        """Move the dry-run book by one completed bar. Returns pending, expired, open, or flat."""
        ot = self.state.open
        if ot is None:
            return "flat"
        bar = self.bars[index]
        if not ot.entry_filled:
            if bar.ts <= ot.signal_bar_ts:
                return "pending"
            fill = resolve_entry_limit_fill(bar, ot.side, ot.entry, ot.stop)
            if fill is not None:
                ot.entry = fill
                ot.entry_filled = True
                ot.entry_ts = bar.ts
                Log.info("SIM FILL %s @ %.2f", ot.side, fill)
                return self._maybe_sim_exit(index)
            waited = self._bars_since_signal(index)
            ot.bars_waited = waited
            if waited >= self.cfg.entryLimitExpiryBars:
                Log.info(
                    "SIM EXPIRE unfilled %s after %s completed 1m bar(s)",
                    ot.side,
                    waited,
                )
                self.state.open = None
                save_state(self.state)
                return "expired"
            return "pending"
        return self._maybe_sim_exit(index)

    def _maybe_sim_exit(self, index: int) -> str:
        ot = self.state.open
        if ot is None or not ot.entry_filled:
            return "flat" if ot is None else "pending"
        bar = self.bars[index]
        exit_fill = resolve_exit_fill(bar, ot.side, ot.stop, ot.target)
        if exit_fill is None:
            return "open"
        price, reason = exit_fill
        self._book_close(price, bar.ts, reason, note="dry-run OHLC")
        return "flat"

    def _open_simulated(self, sig: Signal, signal_bar_ts: int) -> None:
        entry = round_to_tick(sig.entry + self.cfg.limitOffsetTicks * self._tick, self._tick)
        self.state.open = OpenTrade(
            side=sig.side,
            entry=entry,
            stop=round_to_tick(sig.stop, self._tick),
            target=round_to_tick(sig.target, self._tick),
            risk=sig.risk,
            entry_ts=int(time.time() * 1000),
            qty=self.cfg.maxContracts,
            simulated=True,
            entry_filled=False,
            signal_bar_ts=int(signal_bar_ts),
            bars_waited=0,
        )

    def _ib_position_qty(self) -> float:
        assert self.ib and self.contract
        total = 0.0
        for p in self.ib.positions():
            if p.contract.conId == self.contract.conId:
                total += float(p.position)
        return total

    def _order_view(self, order_id: Optional[int]) -> tuple[str, bool, Optional[float], Optional[int]]:
        """Return status, filled, price, and fill time (ms). Status is '' if unknown."""
        if not self.ib or order_id is None:
            return "", False, None, None
        for trade in self.ib.trades():
            order = getattr(trade, "order", None)
            if order is None or getattr(order, "orderId", None) != order_id:
                continue
            fills = list(getattr(trade, "fills", []) or [])
            status_obj = getattr(trade, "orderStatus", None)
            status = str(getattr(status_obj, "status", "") or "")
            filled_qty = float(getattr(status_obj, "filled", 0) or 0)
            filled = status.lower() == "filled" or filled_qty > 0 or bool(fills)
            price: Optional[float] = None
            ts_ms: Optional[int] = None
            if fills:
                last = fills[-1]
                execution = getattr(last, "execution", None)
                exec_price = getattr(execution, "price", None) if execution is not None else None
                if exec_price:
                    price = float(exec_price)
                dt = getattr(last, "time", None)
                if isinstance(dt, datetime):
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=UTC)
                    ts_ms = int(dt.timestamp() * 1000)
            if price is None and filled:
                avg = float(getattr(status_obj, "avgFillPrice", 0) or 0)
                if avg:
                    price = avg
            return status, filled, price, ts_ms
        return "", False, None, None

    def _note_entry_fill(self, price: Optional[float], ts_ms: Optional[int], qty: float) -> None:
        ot = self.state.open
        if ot is None or ot.entry_filled:
            return
        ot.entry_filled = True
        if price:
            ot.entry = price
        if ts_ms:
            ot.entry_ts = ts_ms
        Log.info(
            "ENTRY fill %s @ %.2f parent=%s (order status; position qty=%s)",
            ot.side,
            ot.entry,
            ot.parent_order_id,
            qty,
        )

    def _sync_position_from_ib(self, completed_index: Optional[int] = None) -> None:
        """Track a Paper bracket until it fills, is cancelled, or the entry limit expires.

        positions() is often still flat in the second we place, and again for a moment
        after the parent fills. Dropping local state there skips the later stop, so
        flip lock never arms. Entry fills come from the parent order as well as the
        position. A stop or target fill is booked even when the snapshot never showed
        the size.
        """
        if not self.state.open or self.state.open.simulated:
            return
        ot = self.state.open
        qty = self._ib_position_qty()
        holding = (ot.side == "long" and qty > 0) or (ot.side == "short" and qty < 0)
        parent_status, parent_filled, parent_px, parent_ts = self._order_view(ot.parent_order_id)
        if parent_filled:
            self._note_entry_fill(parent_px, parent_ts, qty)
        if holding:
            if not ot.entry_filled:
                ot.entry_filled = True
                Log.info("ENTRY fill %s from IB position qty=%s", ot.side, qty)
            ot.position_seen = True
            return
        if abs(qty) >= 1e-9:
            # Opposite or unexpected size. Keep the bracket; do not forget it.
            return

        _sl_status, sl_filled, sl_px, sl_ts = self._order_view(ot.sl_order_id)
        _tp_status, tp_filled, tp_px, tp_ts = self._order_view(ot.tp_order_id)
        reason = exit_reason_from_order_fills(sl_filled, tp_filled)
        if reason == "stop":
            self._note_entry_fill(parent_px, parent_ts, qty)
            self._book_ib_exit("stop", sl_px, sl_ts, completed_index)
            return
        if reason == "target":
            self._note_entry_fill(parent_px, parent_ts, qty)
            self._book_ib_exit("target", tp_px, tp_ts, completed_index)
            return

        if not ot.entry_filled:
            if parent_status.lower() in _ENTRY_CANCEL_STATUSES:
                Log.info(
                    "Entry parent %s %s and no position — clearing local open state",
                    ot.parent_order_id,
                    parent_status,
                )
                self.state.open = None
                return
            # Resting, inactive, or not in trades() yet. Expiry cancels a still-working limit.
            return

        if not ot.position_seen and parent_status != "":
            # Parent fill is on this connection, but positions() has not shown it yet.
            return

        # Held and now flat, or a restarted session whose orders are gone and size is 0.
        self._book_ib_exit(None, None, None, completed_index)

    def _book_ib_exit(
        self,
        reason: Optional[str],
        exit_px: Optional[float],
        fill_ts: Optional[int],
        completed_index: Optional[int],
    ) -> None:
        """Book a flat IB position. A stop arms flip lock; a target or manual close does not."""
        ot = self.state.open
        if ot is None:
            return
        if reason == "stop":
            if exit_px is None:
                exit_px = ot.stop
        elif reason == "target":
            if exit_px is None:
                exit_px = ot.target
        else:
            exit_px = self.bars[-1].c if self.bars else ot.entry
            fill_ts = None
            # Order status can lag the position. A bar that traded the stop still arms the lock.
            candidates: list[Bar] = []
            if completed_index is not None and 0 <= completed_index < len(self.bars):
                candidates.append(self.bars[completed_index])
            if self.bars:
                candidates.append(self.bars[-1])
            seen_ts: set[int] = set()
            for candidate in candidates:
                if candidate.ts in seen_ts:
                    continue
                seen_ts.add(candidate.ts)
                ohlc = resolve_exit_fill(candidate, ot.side, ot.stop, ot.target)
                if ohlc is None:
                    continue
                exit_px, reason = ohlc
                fill_ts = candidate.ts
                Log.info("IB flat; bar OHLC exit %s @ %.2f", reason, exit_px)
                break
            if reason is None:
                Log.info("IB flat without a stop or target — flip lock not armed")
        if fill_ts is not None and self.bars:
            covered = bar_covering_ts(self.bars, fill_ts)
            exit_ts = int(covered.ts) if covered is not None else int(fill_ts)
        elif completed_index is not None and 0 <= completed_index < len(self.bars):
            exit_ts = self.bars[completed_index].ts
        elif self.bars:
            exit_ts = self.bars[-1].ts
        else:
            exit_ts = int(time.time() * 1000)
        if exit_px is None:
            exit_px = ot.entry
        Log.info("Position flat on IB — booking close (%s)", reason or "manual")
        self._book_close(exit_px, exit_ts, reason or "manual", note="IB flat detect")

    def _book_close(self, exit_px: float, exit_ts: int, reason: str, note: str) -> None:
        """Account the close. A full stop arms the shared flip lock; a target does not."""
        if not self.state.open or not self.bars:
            return
        ot = self.state.open
        sign = 1 if ot.side == "long" else -1
        points = (exit_px - ot.entry) * sign
        pnl = points * self.cfg.pointValue * ot.qty - self.cfg.roundTripFeeUsd
        self.state.equity += pnl
        self.state.peak_equity = max(self.state.peak_equity, self.state.equity)
        self.state.closed_count += 1
        self.state.total_fees += self.cfg.roundTripFeeUsd
        armed = arm_stop_flip_lock(
            self.state.flip_locks,
            self.flip_lock_bars,
            exit_ts,
            ot.side,
            reason,
        )
        self.state.flip_locks = prune_flip_locks(
            self.state.flip_locks,
            self.bars,
            self.flip_lock_bars,
        )
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
                "exit_ts": exit_ts,
                "exit_reason": reason,
                "tightened": ot.tightened,
                "simulated": ot.simulated,
                "note": note,
            }
        )
        Log.info(
            "CLOSED %s %s entry=%.2f exit=%.2f pnl_acct=$%.2f equity=$%.2f flip_lock=%s",
            reason,
            ot.side,
            ot.entry,
            exit_px,
            pnl,
            self.state.equity,
            armed,
        )
        if armed:
            Log.info(
                "FLIP-LOCK armed after %s stop for %s one-minute bars (opposite side only)",
                ot.side,
                self.flip_lock_bars,
            )
        self.state.open = None
        save_state(self.state)

    def _place_bracket(self, sig: Signal, signal_bar_ts: int) -> None:
        existing = self.state.open
        if existing is not None and not existing.simulated and existing.parent_order_id is not None:
            Log.info(
                "Skip duplicate bracket; state already has open %s parent=%s tp=%s sl=%s",
                existing.side,
                existing.parent_order_id,
                existing.tp_order_id,
                existing.sl_order_id,
            )
            return
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
            "PLACE bracket %s qty=%s lmt=%.2f tp=%.2f sl=%.2f ids=%s/%s/%s "
            "entry_expiry_bars=%s signal_bar_ts=%s",
            action,
            qty,
            entry,
            target,
            stop,
            parent.orderId,
            tp.orderId,
            sl.orderId,
            self.cfg.entryLimitExpiryBars,
            signal_bar_ts,
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
            signal_bar_ts=int(signal_bar_ts),
            bars_waited=0,
        )
        save_state(self.state)

    def _bars_since_signal(self, index: int) -> int:
        """How many completed bars after signal_bar_ts, up to bars[index]."""
        ot = self.state.open
        if not ot or not ot.signal_bar_ts:
            return int(ot.bars_waited) if ot else 0
        n = 0
        for b in self.bars[: index + 1]:
            if b.ts > ot.signal_bar_ts:
                n += 1
        return n

    def _cancel_unfilled_entry(self, reason: str) -> None:
        """Cancel resting parent entry (+ inactive children). Do not touch filled positions."""
        ot = self.state.open
        if not ot or ot.entry_filled:
            return
        Log.warning(
            "EXPIRE unfilled entry %s lmt=%.2f parent=%s — %s",
            ot.side,
            ot.entry,
            ot.parent_order_id,
            reason,
        )
        if self.ib and self.place_orders:
            cancel_ids = {
                i
                for i in (ot.parent_order_id, ot.tp_order_id, ot.sl_order_id)
                if i is not None
            }
            for trade in list(self.ib.openTrades()):
                oid = trade.order.orderId
                if oid in cancel_ids:
                    try:
                        self.ib.cancelOrder(trade.order)
                        Log.info("Cancelled orderId=%s status=%s", oid, trade.orderStatus.status)
                    except Exception:  # noqa: BLE001
                        Log.exception("cancelOrder failed for %s", oid)
        self.state.open = None

    def _modify_take_profit(self, new_tp: float) -> bool:
        """Revise the working TP limit. True only if IB accepted the new price.

        The live order stays in its OCA group. The outbound copy clears
        ocaGroup to "" (already an empty wire field, so this is not a group
        revision) and sets ocaType to UNSET_INTEGER so the type field is
        omitted. Sending ocaType 0 is a type revision: IB error 10327 cancels
        the working TP. 10326 and 10327 both mean the limit was not applied.
        The working order's price and OCA are left unchanged and this returns
        False, so the caller must not log Modified or set tightened. The stop
        is not cancelled. Cancel/replace is not used; it would drop the OCO pair.
        """
        assert self.ib and self.contract and self.state.open
        tp_id = self.state.open.tp_order_id
        if not tp_id:
            Log.warning("No tp_order_id to modify")
            return False
        if self._tp_modify_in_progress:
            Log.warning("TP modify already in progress for order %s", tp_id)
            return False
        trade = None
        for item in self.ib.openTrades():
            order = getattr(item, "order", None)
            if order is not None and getattr(order, "orderId", None) == tp_id:
                trade = item
                break
        if trade is None:
            Log.warning("TP order %s not found in openTrades — may already filled", tp_id)
            return False

        order = trade.order
        prev_group = str(getattr(order, "ocaGroup", "") or "")
        rejects: list[tuple[int, str]] = []

        def _on_error(*args: Any) -> None:
            if len(args) < 3:
                return
            try:
                req_id = int(args[0])
                code = int(args[1])
            except (TypeError, ValueError):
                return
            if req_id != int(tp_id) or code not in _TP_MODIFY_REJECT_CODES:
                return
            rejects.append((code, str(args[2])))

        # Copy so a reject cannot rewrite the working order's price or OCA.
        # Same orderId → modify. "" is an empty ocaGroup field. UNSET omits
        # ocaType; 0 would be sent as "0" and revise type 1 (error 10327).
        outbound = copy(order)
        outbound.lmtPrice = float(new_tp)
        outbound.ocaGroup = ""
        outbound.ocaType = _OCA_TYPE_UNSET
        outbound.transmit = True

        error_event = getattr(self.ib, "errorEvent", None)
        subscribed = False
        self._tp_modify_in_progress = True
        sent = False
        try:
            if error_event is not None:
                error_event += _on_error
                subscribed = True
            self.ib.placeOrder(self.contract, outbound)
            sent = True
            waiter = getattr(self.ib, "sleep", None)
            if callable(waiter):
                waiter(_TP_MODIFY_ACK_SEC)
        except Exception:
            if not sent:
                Log.exception("TP modify failed for order %s", tp_id)
                return False
            Log.exception("TP modify for order %s was sent; ack wait failed", tp_id)
        finally:
            self._tp_modify_in_progress = False
            if subscribed and error_event is not None:
                error_event -= _on_error

        if not sent:
            return False
        if rejects:
            code, text = rejects[0]
            Log.error(
                "TP modify rejected orderId=%s code=%s %s — limit stays %.2f",
                tp_id,
                code,
                text,
                order.lmtPrice,
            )
            return False
        order.lmtPrice = float(new_tp)
        Log.info(
            "Modified TP order %s -> %.2f (OCA omitted on modify; group %s kept)",
            tp_id,
            new_tp,
            prev_group or "-",
        )
        return True

    def _sync_tick(self) -> None:
        if not (self.place_orders and self.state.open and not self.state.open.simulated):
            return
        try:
            completed = len(self.bars) - 2 if len(self.bars) >= 2 else None
            self._sync_position_from_ib(completed)
            save_state(self.state)
        except Exception as exc:  # noqa: BLE001
            if self._connection_failure(exc) or not self._ib_connected():
                self._note_disconnect(exc)
                return
            Log.exception("sync failed")

    def _install_stop_signals(self) -> None:
        try:
            self._prev_sigint = signal.getsignal(signal.SIGINT)
            self._prev_sigterm = signal.getsignal(signal.SIGTERM)
            signal.signal(signal.SIGINT, self._handle_sig)
            signal.signal(signal.SIGTERM, self._handle_sig)
        except (ValueError, OSError):
            Log.warning("Signal handlers not installed (not the main thread)")
            return
        self._signals_installed = True

    def _restore_stop_signals(self) -> None:
        if not self._signals_installed:
            return
        signal.signal(signal.SIGINT, self._prev_sigint)
        signal.signal(signal.SIGTERM, self._prev_sigterm)
        self._signals_installed = False

    def _handle_sig(self, _signum: int, _frame: Any) -> None:
        Log.info("Signal received — shutting down")
        self._stopping = True

    def _shutdown(self) -> None:
        Log.info("Disconnecting…")
        self._stopping = True
        self._reconnecting = True
        try:
            self._cancel_stream()
        except Exception:  # noqa: BLE001
            Log.exception("cancel stream failed")
        ib = self.ib
        if ib is not None:
            try:
                if ib.isConnected():
                    ib.disconnect()
            except Exception:  # noqa: BLE001
                Log.exception("disconnect failed")
        if self._session_started:
            try:
                save_state(self.state)
            except Exception:  # noqa: BLE001
                Log.exception("save state failed")
        Log.info("Stopped. state=%s trades=%s", STATE_PATH, TRADES_PATH)

    def run_forever(self) -> None:
        Log.info(
            "Loop running. Ctrl+C to stop. dry_run=%s place_orders=%s flipLockBars=%s. Paper only.",
            self.dry_run,
            self.place_orders,
            self.flip_lock_bars,
        )
        timeout_sec = int(getattr(self, "_timeout_sec", 0) or 0)
        self._deadline = time.monotonic() + timeout_sec if timeout_sec > 0 else None
        if timeout_sec > 0:
            Log.info("Auto-stop in %ss", timeout_sec)
        self._install_stop_signals()
        try:
            while not self._stopping:
                if self._timed_out():
                    Log.info("Timeout reached — stopping")
                    self._stopping = True
                    break
                if not self._session_ready():
                    if not self._reconnect_session():
                        break
                    continue
                try:
                    self.ib.sleep(1)
                except KeyboardInterrupt:
                    Log.info("Signal received — shutting down")
                    self._stopping = True
                    break
                except Exception as exc:  # noqa: BLE001
                    if self._stopping:
                        break
                    if self._connection_failure(exc) or not self._ib_connected():
                        self._note_disconnect(exc)
                        continue
                    raise
                if self._stopping:
                    break
                if self._timed_out():
                    Log.info("Timeout reached — stopping")
                    self._stopping = True
                    break
                if self._disconnected or not self._ib_connected():
                    self._note_disconnect(None)
                    continue
                self._sync_tick()
        except KeyboardInterrupt:
            Log.info("Signal received — shutting down")
            self._stopping = True
        finally:
            try:
                self._shutdown()
            finally:
                self._restore_stop_signals()


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
    p.add_argument(
        "--flip-lock-bars",
        default=None,
        help="Opposite-side lock after a full stop, in completed 1m bars. "
        "Default 0 (off). Set above 0 to enable. Overrides FLIP_LOCK_BARS and config.json.",
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
    cfg.flipLockBars = resolve_flip_lock_bars(
        None if args.flip_lock_bars is None else str(args.flip_lock_bars),
        os.environ.get("FLIP_LOCK_BARS"),
        cfg.flipLockBars,
    )

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
        loop.run_forever()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        Log.exception("Fatal: %s", exc)
        if loop.ib is not None:
            try:
                if loop.ib.isConnected():
                    loop.ib.disconnect()
            except Exception:  # noqa: BLE001
                pass
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

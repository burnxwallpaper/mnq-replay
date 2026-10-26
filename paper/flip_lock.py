"""Daytime flip lock for the IBKR Paper loop.

The rule is `noteStopFlipLock` / `isOppositeFlipLocked` in `lib/strategy-script.ts`
(and the same entry/exit fill helpers). This module is the in-process mirror so
the Gateway loop can run with Python only. `paper/test_flip_lock.py` executes
those TypeScript helpers and fails if the two disagree.

After a full stop at bar E, a new entry on the opposite side is rejected when
its signal bar is E+1 through E+N inclusive. The signal bar that stopped out
is still allowed. Same-side entries stay allowed. A target exit does not lock.
N defaults to 15. 0 disables the lock. One lock list is shared by long and short.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Protocol, Sequence

DEFAULT_FLIP_LOCK_BARS = 15
MAX_FLIP_LOCK_BARS = 5000


class BarLike(Protocol):
    ts: int
    o: float
    h: float
    l: float
    c: float


@dataclass
class IndexFlipLock:
    """Bar-index lock. `from_bar` is the stop bar; signals on that bar are allowed."""

    from_bar: int
    until_bar: int
    stop_side: str


@dataclass
class TsFlipLock:
    """Persisted lock. `exit_ts` is the stop bar's open time (ms)."""

    exit_ts: int
    stop_side: str


def js_round(n: float) -> int:
    """Match JavaScript Math.round (half towards +infinity)."""
    return int(math.floor(n + 0.5))


def normalize_flip_lock_bars(raw: object, fallback: int = DEFAULT_FLIP_LOCK_BARS) -> int:
    """Match `normalizeFlipLockBars` in lib/strategy-script.ts."""
    try:
        n = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    if not math.isfinite(n) or n < 0:
        return fallback
    return min(MAX_FLIP_LOCK_BARS, js_round(n))


def resolve_flip_lock_bars(
    cli: Optional[str],
    env: Optional[str],
    config_value: object,
) -> int:
    """CLI, then env, then config. Missing/blank CLI and env fall through."""
    if cli is not None and str(cli).strip() != "":
        return normalize_flip_lock_bars(cli)
    if env is not None and str(env).strip() != "":
        return normalize_flip_lock_bars(env)
    if config_value is None:
        return DEFAULT_FLIP_LOCK_BARS
    return normalize_flip_lock_bars(config_value)


def effective_flip_lock_bars(side_mode: str, flip_lock_bars: int) -> int:
    """Web shares the lock only while both runners are on. A single side stays off."""
    if side_mode != "both":
        return 0
    return flip_lock_bars if flip_lock_bars > 0 else 0


def note_stop_flip_lock(
    locks: list[IndexFlipLock],
    flip_lock_bars: int,
    exit_index: int,
    stop_side: str,
    reason: str,
) -> None:
    if flip_lock_bars <= 0 or reason != "stop":
        return
    locks.append(
        IndexFlipLock(
            from_bar=exit_index,
            until_bar=exit_index + int(flip_lock_bars),
            stop_side=stop_side,
        )
    )


def find_opposite_flip_lock(
    locks: Sequence[IndexFlipLock],
    side: str,
    signal_index: int,
) -> Optional[IndexFlipLock]:
    for lock in locks:
        if signal_index <= lock.from_bar:
            continue
        if signal_index > lock.until_bar:
            continue
        if side != lock.stop_side:
            return lock
    return None


def is_opposite_flip_locked(
    locks: Sequence[IndexFlipLock],
    side: str,
    signal_index: int,
) -> bool:
    return find_opposite_flip_lock(locks, side, signal_index) is not None


def arm_stop_flip_lock(
    locks: list[TsFlipLock],
    flip_lock_bars: int,
    exit_ts: int,
    stop_side: str,
    reason: str,
) -> bool:
    """Record a timestamp lock. Returns True when a new lock was stored."""
    if flip_lock_bars <= 0 or reason != "stop":
        return False
    for lock in locks:
        if lock.exit_ts == exit_ts and lock.stop_side == stop_side:
            return False
    locks.append(TsFlipLock(exit_ts=int(exit_ts), stop_side=stop_side))
    return True


def to_index_locks(
    locks: Sequence[TsFlipLock],
    bars: Sequence[BarLike],
    flip_lock_bars: int,
) -> list[IndexFlipLock]:
    if flip_lock_bars <= 0 or not bars:
        return []
    by_ts = {int(bar.ts): index for index, bar in enumerate(bars)}
    first_ts = int(bars[0].ts)
    out: list[IndexFlipLock] = []
    for lock in locks:
        idx = by_ts.get(int(lock.exit_ts))
        if idx is None:
            # Warmup is days of 1m bars. A stop older than the window has expired.
            if lock.exit_ts < first_ts:
                continue
            continue
        out.append(
            IndexFlipLock(
                from_bar=idx,
                until_bar=idx + int(flip_lock_bars),
                stop_side=lock.stop_side,
            )
        )
    return out


def signal_flip_locked(
    locks: Sequence[TsFlipLock],
    bars: Sequence[BarLike],
    side: str,
    signal_index: int,
    flip_lock_bars: int,
) -> Optional[IndexFlipLock]:
    """Return the blocking lock, or None when the signal may be taken."""
    if flip_lock_bars <= 0:
        return None
    return find_opposite_flip_lock(
        to_index_locks(locks, bars, flip_lock_bars),
        side,
        signal_index,
    )


def prune_flip_locks(
    locks: Sequence[TsFlipLock],
    bars: Sequence[BarLike],
    flip_lock_bars: int,
) -> list[TsFlipLock]:
    """Drop locks that can no longer block a signal on the latest completed bar.

    The last bar in a live buffer is still forming, so the newest signal index is
    ``len(bars) - 2``. A lock whose ``until_bar`` is that index must be kept.
    """
    if flip_lock_bars <= 0 or not bars:
        return []
    last_completed = len(bars) - 2 if len(bars) >= 2 else 0
    index_locks = to_index_locks(locks, bars, flip_lock_bars)
    active_ts = {
        int(bars[lock.from_bar].ts)
        for lock in index_locks
        if last_completed <= lock.until_bar
    }
    return [lock for lock in locks if int(lock.exit_ts) in active_ts]


def resolve_entry_limit_fill(
    bar: BarLike,
    side: str,
    limit: float,
    stop: float,
) -> Optional[float]:
    """Match `resolveEntryLimitFill` in lib/strategy-script.ts."""
    if side == "long":
        if bar.o <= stop:
            return None
        if bar.o <= limit:
            return float(bar.o)
        if bar.l <= limit:
            return float(limit)
        return None
    if bar.o >= stop:
        return None
    if bar.o >= limit:
        return float(bar.o)
    if bar.h >= limit:
        return float(limit)
    return None


def resolve_exit_fill(
    bar: BarLike,
    side: str,
    stop: float,
    target: float,
) -> Optional[tuple[float, str]]:
    """Match `resolveExitFill`. Stop wins when both levels are inside the bar."""
    if side == "long":
        if bar.o <= stop:
            return (float(bar.o), "stop")
        if bar.o >= target:
            return (float(bar.o), "target")
        if bar.l <= stop:
            return (float(stop), "stop")
        if bar.h >= target:
            return (float(target), "target")
        return None
    if bar.o >= stop:
        return (float(bar.o), "stop")
    if bar.o <= target:
        return (float(bar.o), "target")
    if bar.h >= stop:
        return (float(stop), "stop")
    if bar.l <= target:
        return (float(target), "target")
    return None


def exit_reason_from_order_fills(sl_filled: bool, tp_filled: bool) -> Optional[str]:
    """IB child fill → strategy exit reason. A filled stop wins over a filled target."""
    if sl_filled:
        return "stop"
    if tp_filled:
        return "target"
    return None


def bar_covering_ts(bars: Sequence[BarLike], ts_ms: int) -> Optional[BarLike]:
    """Last bar whose open time is at or before `ts_ms`."""
    chosen: Optional[BarLike] = None
    for bar in bars:
        if int(bar.ts) <= ts_ms:
            chosen = bar
        else:
            break
    return chosen

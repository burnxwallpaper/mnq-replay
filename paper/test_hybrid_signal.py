#!/usr/bin/env python3
"""Stacked-EMA hybrid sizing parity with engine.mjs (beAtR=0, inclusive lookback)."""
from __future__ import annotations

import unittest
from datetime import datetime, timezone
from pathlib import Path
import sys

PAPER = Path(__file__).resolve().parent
if str(PAPER) not in sys.path:
    sys.path.insert(0, str(PAPER))

import ib_paper_loop as loop


def _ts(i: int) -> int:
    # Monday 2026-10-26 15:00 UTC = 10:00 CT session
    start = int(datetime(2026, 10, 26, 15, 0, tzinfo=timezone.utc).timestamp() * 1000)
    return start + i * 60_000


def _bar(i: int, o: float, h: float, l: float, c: float, v: float = 10.0) -> loop.Bar:
    return loop.Bar(ts=_ts(i), o=o, h=h, l=l, c=c, v=v)


class HybridSizingTest(unittest.TestCase):
    def _trend_bars(self, n: int = 120, *, rising: bool = True) -> list[loop.Bar]:
        bars: list[loop.Bar] = []
        for i in range(n):
            base = (100.0 + i * 0.5) if rising else (200.0 - i * 0.5)
            bars.append(_bar(i, base, base + 0.25, base - 0.25, base, 10))
        return bars

    def test_long_up_bar_uses_reward_multiple_to_h50(self) -> None:
        bars = self._trend_bars(120, rising=True)
        # Force a clear up bar with volume spike and room above close to H50.
        i = 110
        # Prior high at i-1 already ~154.5; push this bar higher with wick.
        entry = bars[i - 1].c + 0.5
        h50_candidate = entry + 7.0
        bars[i] = _bar(i, entry - 1.0, h50_candidate, entry - 1.5, entry, 5000)
        filters = loop.Filters(volLen=10, volMult=1.8)
        result = loop.evaluate_bar(
            bars, i, filters, "both", None, 3.5,
            ema_fast=20, ema_mid=50, ema_slow=100,
            lookback_high=50, hybrid_down_half_as_r=2, hybrid_up_half_as_r=2,
        )
        self.assertIsNotNone(result.signal)
        assert result.signal is not None
        self.assertEqual(result.signal.side, "long")
        h50 = loop.lookback_high_inclusive(bars, i, 50)
        self.assertEqual(result.signal.target, h50)
        risk = (h50 - entry) / 3.5
        self.assertAlmostEqual(result.signal.risk, risk)
        self.assertAlmostEqual(result.signal.stop, entry - risk)
        self.assertIsNone(result.tighten_target)
        self.assertFalse(result.ema_exit_close)

    def test_long_down_bar_hybrid_halfdist_from_h50(self) -> None:
        bars = self._trend_bars(120, rising=True)
        i = 110
        entry = bars[i - 1].c
        # Down bar (c < o) with volume; H50 above entry.
        h50_candidate = entry + 8.0
        bars[i] = _bar(i, entry + 1.0, h50_candidate, entry - 0.5, entry, 5000)
        filters = loop.Filters(volLen=10, volMult=1.8)
        result = loop.evaluate_bar(
            bars, i, filters, "long", None, 3.5,
            hybrid_down_half_as_r=2, hybrid_up_half_as_r=2,
        )
        self.assertIsNotNone(result.signal)
        assert result.signal is not None
        h50 = loop.lookback_high_inclusive(bars, i, 50)
        half = (h50 - entry) / 2.0
        self.assertAlmostEqual(result.signal.target, entry + half)
        self.assertAlmostEqual(result.signal.risk, half / 2.0)
        self.assertAlmostEqual(result.signal.stop, entry - half / 2.0)

    def test_short_down_bar_uses_reward_multiple_to_l50(self) -> None:
        bars = self._trend_bars(120, rising=False)
        i = 110
        entry = bars[i - 1].c - 0.5
        l50_candidate = entry - 7.0
        bars[i] = _bar(i, entry + 1.0, entry + 1.5, l50_candidate, entry, 5000)
        filters = loop.Filters(volLen=10, volMult=1.8)
        result = loop.evaluate_bar(
            bars, i, filters, "both", None, 3.5,
            hybrid_down_half_as_r=2, hybrid_up_half_as_r=2,
        )
        self.assertIsNotNone(result.signal)
        assert result.signal is not None
        self.assertEqual(result.signal.side, "short")
        l50 = loop.lookback_low_inclusive(bars, i, 50)
        self.assertEqual(result.signal.target, l50)
        risk = (entry - l50) / 3.5
        self.assertAlmostEqual(result.signal.risk, risk)
        self.assertAlmostEqual(result.signal.stop, entry + risk)

    def test_short_up_bar_hybrid_halfdist_from_l50(self) -> None:
        bars = self._trend_bars(120, rising=False)
        i = 110
        entry = bars[i - 1].c
        l50_candidate = entry - 8.0
        bars[i] = _bar(i, entry - 1.0, entry + 0.5, l50_candidate, entry, 5000)
        filters = loop.Filters(volLen=10, volMult=1.8)
        result = loop.evaluate_bar(
            bars, i, filters, "short", None, 3.5,
            hybrid_down_half_as_r=2, hybrid_up_half_as_r=2,
        )
        self.assertIsNotNone(result.signal)
        assert result.signal is not None
        l50 = loop.lookback_low_inclusive(bars, i, 50)
        half = (entry - l50) / 2.0
        self.assertAlmostEqual(result.signal.target, entry - half)
        self.assertAlmostEqual(result.signal.risk, half / 2.0)
        self.assertAlmostEqual(result.signal.stop, entry + half / 2.0)

    def test_open_trade_returns_no_ema_tighten(self) -> None:
        bars = self._trend_bars(120, rising=True)
        ot = loop.OpenTrade(
            side="long", entry=100, stop=90, target=125, risk=10,
            entry_ts=bars[0].ts, qty=1, entry_filled=True,
        )
        result = loop.evaluate_bar(bars, 110, loop.Filters(), "both", ot, 3.5)
        self.assertIsNone(result.signal)
        self.assertIsNone(result.tighten_target)
        self.assertFalse(result.ema_exit_close)

    def test_load_config_hybrid_defaults(self) -> None:
        cfg = loop.load_config()
        self.assertEqual(cfg.strategy, "stacked-ema-hybrid")
        self.assertEqual(cfg.emaFast, 20)
        self.assertEqual(cfg.emaMid, 50)
        self.assertEqual(cfg.emaSlow, 100)
        self.assertEqual(cfg.filters.volLen, 10)
        self.assertEqual(cfg.filters.volMult, 1.8)
        self.assertEqual(cfg.rewardMultiple, 3.5)
        self.assertEqual(cfg.hybridDownHalfAsR, 2.0)
        self.assertEqual(cfg.hybridUpHalfAsR, 2.0)
        self.assertEqual(cfg.lookbackHigh, 50)
        self.assertEqual(cfg.side, "both")
        self.assertEqual(cfg.flipLockBars, 0)


if __name__ == "__main__":
    unittest.main()

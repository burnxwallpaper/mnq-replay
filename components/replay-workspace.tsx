"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BacktestReport } from "@/components/backtest-report";
import { CandleChart } from "@/components/candle-chart";
import { ReplayTransport } from "@/components/replay-transport";
import { StrategyEditor } from "@/components/strategy-editor";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  FIXTURE_NOTE,
  formatFixturePrice,
  formatFixtureTime,
  loadMnqBars,
  type FixtureBar,
} from "@/lib/fixture-bars";
import { EntryFiltersPanel } from "@/components/entry-filters";
import {
  DEFAULT_ENTRY_FILTERS,
  DEFAULT_FLIP_LOCK_BARS,
  DEFAULT_ROUND_TRIP_FEE_USD,
  ENTRY_FILTERS_STORAGE_KEY,
  EVE_ENTRY_FILTERS,
  EVE_LONG_STRATEGY_SCRIPT,
  EVE_SHORT_STRATEGY_SCRIPT,
  FLIP_LOCK_BARS_STORAGE_KEY,
  ROUND_TRIP_FEE_STORAGE_KEY,
  STRATEGY_COLORS,
  STRATEGY_PRESETS,
  STRATEGY_PRESET_STORAGE_KEY,
  buildLongStrategyScript,
  buildShortStrategyScript,
  mergeScriptRuns,
  normalizeEntryFilters,
  normalizeFlipLockBars,
  normalizeRoundTripFee,
  normalizeStrategyPreset,
  runLinkedStrategyScripts,
  runStrategyScript,
  scoreScript,
  summarizeMultiBacktest,
  type EntryFilters,
  type NamedScriptRun,
  type ScriptRun,
  type StrategyPresetId,
} from "@/lib/strategy-script";

const PLAY_MS = 180;
const INITIAL_VISIBLE = 180;
const RUNNERS_STORAGE_KEY = "mnq-replay.enabledRunners";
const SHOW_PRICE_CHART_STORAGE_KEY = "mnq-replay.showPriceChart";

function formatPoints(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)} pts`;
}

function formatPnl(value: number) {
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function readEnabledRunners(): { long: boolean; short: boolean } {
  try {
    const raw = window.localStorage.getItem(RUNNERS_STORAGE_KEY);
    if (!raw) return { long: true, short: false };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { long: true, short: false };
    const record = parsed as Record<string, unknown>;
    return {
      long: record.long !== false,
      short: record.short === true,
    };
  } catch {
    return { long: true, short: false };
  }
}

function writeEnabledRunners(long: boolean, short: boolean) {
  try {
    window.localStorage.setItem(RUNNERS_STORAGE_KEY, JSON.stringify({ long, short }));
  } catch {
    // Ignore private-mode storage failures.
  }
}

function readEntryFilters(): EntryFilters {
  try {
    const raw = window.localStorage.getItem(ENTRY_FILTERS_STORAGE_KEY);
    if (!raw) return DEFAULT_ENTRY_FILTERS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_ENTRY_FILTERS;
    return normalizeEntryFilters(parsed as Partial<EntryFilters>);
  } catch {
    return DEFAULT_ENTRY_FILTERS;
  }
}

function writeEntryFilters(filters: EntryFilters) {
  try {
    window.localStorage.setItem(ENTRY_FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Ignore private-mode storage failures.
  }
}

function readRoundTripFee(): number {
  try {
    const raw = window.localStorage.getItem(ROUND_TRIP_FEE_STORAGE_KEY);
    if (raw === null) return DEFAULT_ROUND_TRIP_FEE_USD;
    return normalizeRoundTripFee(JSON.parse(raw));
  } catch {
    return DEFAULT_ROUND_TRIP_FEE_USD;
  }
}

function writeRoundTripFee(feeUsd: number) {
  try {
    window.localStorage.setItem(
      ROUND_TRIP_FEE_STORAGE_KEY,
      JSON.stringify(normalizeRoundTripFee(feeUsd)),
    );
  } catch {
    // Ignore private-mode storage failures.
  }
}

function readFlipLockBars(): number {
  try {
    const raw = window.localStorage.getItem(FLIP_LOCK_BARS_STORAGE_KEY);
    if (raw === null) return DEFAULT_FLIP_LOCK_BARS;
    return normalizeFlipLockBars(JSON.parse(raw));
  } catch {
    return DEFAULT_FLIP_LOCK_BARS;
  }
}

function writeFlipLockBars(bars: number) {
  try {
    window.localStorage.setItem(
      FLIP_LOCK_BARS_STORAGE_KEY,
      JSON.stringify(normalizeFlipLockBars(bars)),
    );
  } catch {
    // Ignore private-mode storage failures.
  }
}

function readStrategyPreset(): StrategyPresetId {
  try {
    return normalizeStrategyPreset(window.localStorage.getItem(STRATEGY_PRESET_STORAGE_KEY));
  } catch {
    return "day";
  }
}

function writeStrategyPreset(preset: StrategyPresetId) {
  try {
    window.localStorage.setItem(STRATEGY_PRESET_STORAGE_KEY, preset);
  } catch {
    // Ignore private-mode storage failures.
  }
}

function readShowPriceChart(): boolean {
  try {
    const raw = window.localStorage.getItem(SHOW_PRICE_CHART_STORAGE_KEY);
    if (raw === null) return false;
    if (raw === "true") return true;
    if (raw === "false") return false;
    const parsed: unknown = JSON.parse(raw);
    return parsed === true;
  } catch {
    return false;
  }
}

function writeShowPriceChart(show: boolean) {
  try {
    window.localStorage.setItem(SHOW_PRICE_CHART_STORAGE_KEY, show ? "true" : "false");
  } catch {
    // Ignore private-mode storage failures.
  }
}

export function ReplayWorkspace() {
  const [bars, setBars] = useState<FixtureBar[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [longSource, setLongSource] = useState<string | null>(null);
  const [longRun, setLongRun] = useState<ScriptRun | null>(null);
  const [longEnabled, setLongEnabled] = useState(true);
  const [shortEnabled, setShortEnabled] = useState(false);
  const [fitRevision, setFitRevision] = useState(0);
  const [entryFilters, setEntryFilters] = useState<EntryFilters>(DEFAULT_ENTRY_FILTERS);
  const [roundTripFeeUsd, setRoundTripFeeUsd] = useState(DEFAULT_ROUND_TRIP_FEE_USD);
  const [flipLockBars, setFlipLockBars] = useState(DEFAULT_FLIP_LOCK_BARS);
  const [filtersEpoch, setFiltersEpoch] = useState(0);
  const [showPriceChart, setShowPriceChart] = useState(false);
  const [presetId, setPresetId] = useState<StrategyPresetId>("day");
  const [presetEpoch, setPresetEpoch] = useState(0);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const priceChartHydratedRef = useRef(false);
  const lastIndex = bars ? bars.length - 1 : 0;
  const toggleRef = useRef<() => void>(() => {});

  useEffect(() => {
    const saved = readEnabledRunners();
    const preset = readStrategyPreset();
    setPresetId(preset);
    if (preset === "eve") {
      setLongEnabled(true);
      setShortEnabled(true);
      setEntryFilters(EVE_ENTRY_FILTERS);
    } else {
      setLongEnabled(saved.long);
      setShortEnabled(saved.short);
      setEntryFilters(readEntryFilters());
    }
    setRoundTripFeeUsd(readRoundTripFee());
    setFlipLockBars(readFlipLockBars());
    setShowPriceChart(readShowPriceChart());
    priceChartHydratedRef.current = true;
    setSettingsHydrated(true);
  }, []);

  useEffect(() => {
    if (!settingsHydrated || presetId !== "day") return;
    writeEnabledRunners(longEnabled, shortEnabled);
  }, [longEnabled, shortEnabled, presetId, settingsHydrated]);

  useEffect(() => {
    if (!settingsHydrated) return;
    writeStrategyPreset(presetId);
  }, [presetId, settingsHydrated]);

  useEffect(() => {
    if (!priceChartHydratedRef.current) return;
    writeShowPriceChart(showPriceChart);
  }, [showPriceChart]);

  useEffect(() => {
    if (!settingsHydrated || presetId !== "day") return;
    writeEntryFilters(entryFilters);
  }, [entryFilters, presetId, settingsHydrated]);

  useEffect(() => {
    if (!settingsHydrated) return;
    writeRoundTripFee(roundTripFeeUsd);
  }, [roundTripFeeUsd, settingsHydrated]);

  useEffect(() => {
    if (!settingsHydrated) return;
    writeFlipLockBars(flipLockBars);
  }, [flipLockBars, settingsHydrated]);

  useEffect(() => {
    let cancelled = false;
    loadMnqBars()
      .then((loaded) => {
        if (cancelled) return;
        setBars(loaded);
        setIndex(Math.max(0, loaded.length - INITIAL_VISIBLE));
        setFitRevision((current) => current + 1);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Failed to load bars");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  toggleRef.current = () => {
    if (!bars) return;
    if (!playing && index >= lastIndex) setIndex(0);
    setPlaying((current) => !current);
  };

  useEffect(() => {
    if (!playing || !bars) return;
    const timer = window.setInterval(() => {
      setIndex((current) => Math.min(lastIndex, current + 1));
    }, PLAY_MS);
    return () => window.clearInterval(timer);
  }, [playing, lastIndex, bars]);

  useEffect(() => {
    if (playing && index >= lastIndex) setPlaying(false);
  }, [playing, index, lastIndex]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== " ") return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLButtonElement ||
        target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      event.preventDefault();
      toggleRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function toggle() {
    toggleRef.current();
  }

  function selectPreset(next: StrategyPresetId) {
    setPresetId(next);
    setPresetEpoch((current) => current + 1);
    if (next === "eve") {
      setLongEnabled(true);
      setShortEnabled(true);
      setEntryFilters(EVE_ENTRY_FILTERS);
      return;
    }
    const saved = readEnabledRunners();
    setLongEnabled(saved.long);
    setShortEnabled(saved.short);
    setEntryFilters(readEntryFilters());
    setFlipLockBars(readFlipLockBars());
  }

  function scrub(next: number) {
    setPlaying(false);
    setIndex(Math.min(lastIndex, Math.max(0, next)));
  }

  function step(delta: number) {
    setPlaying(false);
    setIndex((current) => Math.min(lastIndex, Math.max(0, current + delta)));
  }

  const namedRuns: NamedScriptRun[] = useMemo(() => {
    if (!bars) return [];
    const list: NamedScriptRun[] = [];
    const eve = presetId === "eve";
    // Daytime long+short share one flip lock. Eve stays on two independent runs.
    if (!eve && longEnabled && shortEnabled && longSource) {
      const linked = runLinkedStrategyScripts(
        bars,
        [
          { id: "long", source: longSource },
          { id: "short", source: buildShortStrategyScript(entryFilters) },
        ],
        { flipLockBars },
      );
      if (!linked.ok) {
        return [
          {
            id: "long",
            name: "Long strategy",
            color: STRATEGY_COLORS.long,
            run: { ok: false, error: linked.error, markers: [], trades: [] },
          },
        ];
      }
      return linked.runs.map((item) => ({
        id: item.id,
        name: item.id === "short" ? "Short strategy" : "Long strategy",
        color: item.id === "short" ? STRATEGY_COLORS.short : STRATEGY_COLORS.long,
        run: item.run,
      }));
    }
    if (longEnabled) {
      const eveSource =
        longSource && longSource.includes("PRESET=eve-2030-2359")
          ? longSource
          : EVE_LONG_STRATEGY_SCRIPT;
      const run = eve
        ? runStrategyScript(bars, eveSource, "long")
        : (longRun ?? (longSource ? runStrategyScript(bars, longSource, "long") : null));
      if (run) {
        list.push({
          id: "long",
          name: "Long strategy",
          color: STRATEGY_COLORS.long,
          run,
        });
      }
    }
    if (shortEnabled) {
      list.push({
        id: "short",
        name: "Short strategy",
        color: STRATEGY_COLORS.short,
        run: runStrategyScript(
          bars,
          eve ? EVE_SHORT_STRATEGY_SCRIPT : buildShortStrategyScript(entryFilters),
          "short",
        ),
      });
    }
    return list;
  }, [bars, longEnabled, shortEnabled, longRun, longSource, entryFilters, presetId, flipLockBars]);

  const mergedRun = useMemo(() => {
    if (namedRuns.length === 0) return null;
    return mergeScriptRuns(namedRuns);
  }, [namedRuns]);

  const periodEnd = bars ? bars.length - 1 : 0;
  const score = useMemo(() => {
    if (!bars || !mergedRun?.ok) return null;
    return scoreScript(mergedRun.trades, bars, periodEnd, roundTripFeeUsd);
  }, [mergedRun, periodEnd, bars, roundTripFeeUsd]);
  const multiReport = useMemo(() => {
    if (!bars || namedRuns.length === 0) return null;
    if (namedRuns.some((item) => !item.run.ok)) return null;
    return summarizeMultiBacktest(namedRuns, bars, roundTripFeeUsd);
  }, [namedRuns, bars, roundTripFeeUsd]);

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[720px] flex-col gap-3 p-6">
        <h1 className="font-mono text-lg font-medium">MNQ Replay</h1>
        <p className="text-sm text-muted-foreground">{loadError}</p>
      </main>
    );
  }

  if (!bars) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-[720px] flex-col gap-3 p-6">
        <h1 className="font-mono text-lg font-medium">MNQ Replay</h1>
        <p className="font-mono text-sm text-muted-foreground">
          Loading MNQ 1m history…
        </p>
      </main>
    );
  }

  const cursor = bars[index];
  const bothRunners = longEnabled && shortEnabled;
  const chartMarkers = (mergedRun?.ok ? mergedRun.markers : []).map((marker) => ({
    strategyId: marker.strategyId,
    barIndex: marker.barIndex,
    visibleFromIndex: marker.visibleFromIndex,
    kind: marker.kind,
    win: marker.win,
    localIndex: marker.barIndex,
    ...(typeof marker.price === "number" ? { price: marker.price } : {}),
    ...(marker.side ? { side: marker.side } : {}),
  }));
  const entryCount = chartMarkers.filter((marker) => marker.kind === "entry").length;
  const exitCount = chartMarkers.filter((marker) => marker.kind === "exit").length;
  const tradeCount = mergedRun?.ok ? mergedRun.trades.length : 0;
  const tradeLabel = tradeCount === 1 ? "1 trade" : `${tradeCount} trades`;
  const entryLabel = entryCount === 1 ? "1 entry" : `${entryCount} entries`;
  const exitLabel = exitCount === 1 ? "1 exit" : `${exitCount} exits`;
  const cursorLabel = formatFixtureTime(cursor.ts);
  const earliestLabel = formatFixtureTime(bars[0].ts);
  const latestLabel = formatFixtureTime(bars[bars.length - 1].ts);
  const fields = [
    ["O", formatFixturePrice(cursor.o)],
    ["H", formatFixturePrice(cursor.h)],
    ["L", formatFixturePrice(cursor.l)],
    ["C", formatFixturePrice(cursor.c)],
    ["V", cursor.v.toLocaleString("en-US")],
  ] as const;
  const runnerError = namedRuns.find((item) => !item.run.ok);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[1440px] flex-col gap-3 p-3 sm:p-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-lg font-medium tracking-tight">
              MNQ Replay
            </h1>
            <Badge variant="outline">1m</Badge>
            <Badge variant="secondary">MNQ1! live dump</Badge>
            <Badge variant={playing ? "default" : "outline"}>
              {playing ? "Playing" : "Paused"}
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {FIXTURE_NOTE} {bars.length.toLocaleString("en-US")} bars ·{" "}
            {earliestLabel} → {latestLabel}. Drag the chart to pan. Drag the
            right price scale up or down to zoom. Scroll to zoom time. Replay
            only moves the cursor.
          </p>
        </div>
        <p className="font-mono text-sm text-foreground">{cursorLabel}</p>
      </header>

      <div
        id="strategy-runners"
        className="flex flex-col gap-1.5 rounded-lg bg-foreground/5 px-3 py-2 font-mono text-sm"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs tracking-wide text-muted-foreground uppercase">
            Strategies
          </span>
          <label className="inline-flex items-center gap-2" htmlFor="strategy-preset">
            <span className="text-xs tracking-wide text-muted-foreground uppercase">Preset</span>
            <select
              id="strategy-preset"
              value={presetId}
              onChange={(event) => selectPreset(normalizeStrategyPreset(event.target.value))}
              className="max-w-[22rem] rounded-md border border-foreground/15 bg-background px-2 py-1 text-xs text-foreground"
            >
              {STRATEGY_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            id="strategy-preset-reload"
            onClick={() => selectPreset(presetId)}
            className="rounded-md border border-foreground/15 px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Reload preset
          </button>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              id="runner-long"
              type="checkbox"
              checked={longEnabled}
              onChange={(event) => {
                const next = event.target.checked;
                if (!next && !shortEnabled) return;
                setLongEnabled(next);
                setFitRevision((current) => current + 1);
              }}
            />
            <span style={{ color: STRATEGY_COLORS.long }}>Long strategy</span>
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              id="runner-short"
              type="checkbox"
              checked={shortEnabled}
              onChange={(event) => {
                const next = event.target.checked;
                if (!next && !longEnabled) return;
                setShortEnabled(next);
                setFitRevision((current) => current + 1);
              }}
            />
            <span style={{ color: STRATEGY_COLORS.short }}>Short strategy</span>
          </label>
        </div>
        <p id="strategy-runners-help" className="text-xs text-muted-foreground">
          {presetId === "eve"
            ? "Eve candidate: CT 20:30–23:59 only, vstrict 0.7/6/20×2.2, stop 2× risk1, target and EMA→1R still use risk1. Combined long+short. Daytime stays the default when you switch back."
            : `Daytime default: CT 09:00–20:29, Fri no new entries from 14:45, filters 0.45/2/15×1.2, stop at the bar extreme, flip lock ${flipLockBars} (0 = off; above 0 blocks a new opposite-side entry for that many 1m bars after a full stop, Save to apply). Long and Short share that lock when both are checked.`}
        </p>
        {presetId === "eve" ? (
          <p id="strategy-preset-note" className="text-xs text-muted-foreground">
            Parked for another look after more MNQ 1m data — not a replacement for the daytime
            session. Snapshot on this 41581-bar file (re-run after each refresh; not live truth):
            about $10,642 final asset, max DD $185, win rate 69%, 62 trades. Avg RR here is in
            risk1 units (about +0.38R). The earlier +0.19 counted those same results off the 2×
            stop. Fee $1.6, 1 contract, entry limit expires after 2 bars.
          </p>
        ) : null}
      </div>

      <EntryFiltersPanel
        value={entryFilters}
        feeUsd={roundTripFeeUsd}
        flipLockBars={flipLockBars}
        locked={presetId === "eve"}
        lockedNote="Eve preset bakes vstrict 0.7 / 6 / SMA(20) × 2.2 into both scripts and does not use the daytime flip lock. Switch to Daytime to edit filters and flip lock. Round-trip fee still applies."
        onChange={(next) => {
          setEntryFilters(normalizeEntryFilters(next.filters));
          setRoundTripFeeUsd(normalizeRoundTripFee(next.roundTripFeeUsd));
          if (next.flipLockBars !== undefined) {
            setFlipLockBars(normalizeFlipLockBars(next.flipLockBars));
          }
          setFiltersEpoch((n) => n + 1);
          setFitRevision((current) => current + 1);
        }}
      />

      <p id="backtest-summary" className="font-mono text-sm">
        {score
          ? `Full period · ${tradeLabel} · ${formatPoints(score.totalPoints)} · ${formatPnl(score.totalPnl)} · ${score.wins} wins · ${score.losses} losses · ${entryLabel} · ${exitLabel}`
          : runnerError && !runnerError.run.ok
            ? `${runnerError.name}: ${runnerError.run.error}`
            : "Full period backtest appears when a strategy is checked (Apply updates Long)."}
      </p>

      <p className="sr-only" role="status">
        {playing ? "Playing" : "Paused"} at {cursorLabel}, bar {index + 1} of{" "}
        {bars.length}.
      </p>

      <div className="grid flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-w-0 flex-col gap-3">
        {showPriceChart ? (
        <section
          aria-label="Candlestick chart"
          className="relative min-h-[340px] flex-1 overflow-hidden rounded-xl bg-[oklch(0.145_0.016_255)] ring-1 ring-foreground/10 lg:min-h-[520px]"
        >
          <div className="pointer-events-none absolute top-3 left-3 z-10 flex gap-3 text-[10px] tracking-wide text-muted-foreground uppercase">
            <span>Drag to pan</span>
            <span className="text-[oklch(0.84_0.14_88)]">Signal</span>
            <span className="text-[oklch(0.78_0.15_155)]">Long</span>
            <span className="text-[#7aa2ff]">Short</span>
            <span>Exit</span>
            <span className="text-[#39d0ff]">EMA 5</span>
          </div>
          <div className="absolute top-2 right-2 z-10">
            <button
              type="button"
              onClick={() => setShowPriceChart(false)}
              className="rounded-md border border-foreground/15 bg-[oklch(0.18_0.02_255)] px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Hide price chart
            </button>
          </div>
          <CandleChart
            bars={bars}
            markers={chartMarkers}
            cursorIndex={index}
            fitRevision={fitRevision}
            labelStrategies={bothRunners}
          />
        </section>
        ) : (
        <section
          aria-label="Price chart hidden"
          className="flex items-center justify-between gap-3 rounded-xl bg-[oklch(0.145_0.016_255)] px-3 py-2 ring-1 ring-foreground/10"
        >
          <p className="text-xs text-muted-foreground">
            Price chart hidden (faster). Equity / backtest report stays below.
          </p>
          <button
            type="button"
            onClick={() => setShowPriceChart(true)}
            className="shrink-0 rounded-md border border-foreground/15 bg-[oklch(0.18_0.02_255)] px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            Show price chart
          </button>
        </section>
        )}
        <BacktestReport report={multiReport} />
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Cursor bar</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="flex flex-col gap-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Symbol</dt>
                <dd className="font-mono text-xs">MNQ1!</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Timeframe</dt>
                <dd className="font-mono text-xs">1 minute</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Source</dt>
                <dd className="text-right text-xs">TV Premium prodata</dd>
              </div>
            </dl>
            <Separator />
            <dl className="flex flex-col gap-1.5 font-mono text-sm">
              {fields.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-[10px] text-muted-foreground">{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <Separator />
            <div className="flex flex-col gap-2">
              <p className="text-xs tracking-wide text-muted-foreground uppercase">
                Full period
              </p>
              {score ? (
                <dl className="flex flex-col gap-1 font-mono text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Trades</dt>
                    <dd>{tradeCount}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Total pts</dt>
                    <dd>{formatPoints(score.totalPoints)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Total PnL</dt>
                    <dd>{formatPnl(score.totalPnl)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Realized</dt>
                    <dd>
                      {formatPoints(score.realizedPoints)} · {score.closedTrades}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Open</dt>
                    <dd>
                      {formatPoints(score.openPoints)} · {score.openTrades}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Wins</dt>
                    <dd>
                      {score.wins} · {score.losses} losses
                    </dd>
                  </div>
                  {multiReport
                    ? multiReport.perStrategy.map((item) => (
                        <div key={item.id} className="flex justify-between gap-3">
                          <dt style={{ color: item.color }}>{item.name}</dt>
                          <dd>{formatPnl(item.stats.endingEquity)}</dd>
                        </div>
                      ))
                    : null}
                </dl>
              ) : runnerError && !runnerError.run.ok ? (
                <p className="text-sm text-muted-foreground">Script has an error.</p>
              ) : (
                <p className="text-sm text-muted-foreground">Running script.</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <ReplayTransport
        playing={playing}
        index={index}
        count={bars.length}
        cursorLabel={cursorLabel}
        onToggle={toggle}
        onScrub={scrub}
        onStep={step}
        onJump={scrub}
      />

      <StrategyEditor
        bars={bars}
        presetId={presetId}
        presetEpoch={presetEpoch}
        defaultScript={() =>
          presetId === "eve" ? EVE_LONG_STRATEGY_SCRIPT : buildLongStrategyScript(entryFilters)
        }
        filtersKey={
          presetId === "day" && filtersEpoch > 0
            ? `${filtersEpoch}:${JSON.stringify(entryFilters)}`
            : undefined
        }
        onApply={(source, run) => {
          setLongSource(source);
          setLongRun(run);
          if (run.ok) setFitRevision((current) => current + 1);
        }}
      />

      <p className="text-xs text-muted-foreground">
        The Preset menu chooses Daytime (default) or the parked Eve candidate. Check Long
        and/or Short above the chart to run them. The editor edits the Long leg; Short follows
        the active preset. Equity shows one line per strategy plus Combined when both are on.
        Daytime flip lock defaults to 0 (off). Set Flip lock bars above 0 and Save to block a
        new opposite-side entry after a full stop, and only while both runners are on. Replay
        only moves the cursor. The paper/IB loop uses this same lock when both sides are on.
      </p>
    </main>
  );
}

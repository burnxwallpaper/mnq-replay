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
import { scoreScript, summarizeBacktest, type ScriptRun } from "@/lib/strategy-script";

const PLAY_MS = 180;
const INITIAL_VISIBLE = 180;

function formatR(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)} R`;
}

function formatPnl(value: number) {
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export function ReplayWorkspace() {
  const [bars, setBars] = useState<FixtureBar[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scriptRun, setScriptRun] = useState<ScriptRun | null>(null);
  const [fitRevision, setFitRevision] = useState(0);
  const lastIndex = bars ? bars.length - 1 : 0;
  const toggleRef = useRef<() => void>(() => {});

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

  function scrub(next: number) {
    setPlaying(false);
    setIndex(Math.min(lastIndex, Math.max(0, next)));
  }

  function step(delta: number) {
    setPlaying(false);
    setIndex((current) => Math.min(lastIndex, Math.max(0, current + delta)));
  }

  const periodEnd = bars ? bars.length - 1 : 0;
  const score = useMemo(() => {
    if (!bars || !scriptRun?.ok) return null;
    return scoreScript(scriptRun.trades, bars, periodEnd);
  }, [scriptRun, periodEnd, bars]);
  const backtestStats = useMemo(() => {
    if (!bars || !scriptRun?.ok) return null;
    return summarizeBacktest(scriptRun, bars);
  }, [scriptRun, bars]);

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
  const chartMarkers = (scriptRun?.ok ? scriptRun.markers : []).map((marker) => ({
    strategyId: "script",
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
  const tradeCount = scriptRun?.ok ? scriptRun.trades.length : 0;
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

      <p id="backtest-summary" className="font-mono text-sm">
        {score
          ? `Full period · ${tradeLabel} · ${formatR(score.totalR)} · ${formatPnl(score.totalPnl)} · ${score.wins} wins · ${score.losses} losses · ${entryLabel} · ${exitLabel}`
          : scriptRun && !scriptRun.ok
            ? scriptRun.error
            : "Full period backtest appears after Apply strategy."}
      </p>

      <p className="sr-only" role="status">
        {playing ? "Playing" : "Paused"} at {cursorLabel}, bar {index + 1} of{" "}
        {bars.length}.
      </p>

      <div className="grid flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-w-0 flex-col gap-3">
        <section
          aria-label="Candlestick chart"
          className="relative min-h-[340px] flex-1 overflow-hidden rounded-xl bg-[oklch(0.145_0.016_255)] ring-1 ring-foreground/10 lg:min-h-[520px]"
        >
          <div className="pointer-events-none absolute top-3 left-3 z-10 flex gap-3 text-[10px] tracking-wide text-muted-foreground uppercase">
            <span>Drag to pan</span>
            <span className="text-[oklch(0.84_0.14_88)]">Signal</span>
            <span className="text-[oklch(0.78_0.15_155)]">Entry</span>
            <span>Exit</span>
          </div>
          <CandleChart
            bars={bars}
            markers={chartMarkers}
            cursorIndex={index}
            fitRevision={fitRevision}
          />
        </section>
        <BacktestReport stats={backtestStats} />
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
                    <dt className="text-muted-foreground">Total R</dt>
                    <dd>{formatR(score.totalR)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Total PnL</dt>
                    <dd>{formatPnl(score.totalPnl)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Realized</dt>
                    <dd>
                      {formatR(score.realizedR)} · {score.closedTrades}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Open</dt>
                    <dd>
                      {formatR(score.openR)} · {score.openTrades}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Wins</dt>
                    <dd>
                      {score.wins} · {score.losses} losses
                    </dd>
                  </div>
                </dl>
              ) : scriptRun && !scriptRun.ok ? (
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
        onRun={(run) => {
          setScriptRun(run);
          if (run.ok) setFitRevision((current) => current + 1);
        }}
      />

      <p className="text-xs text-muted-foreground">
        Apply strategy draws entries and exits for the whole loaded series,
        the equity curve, and the stats below the chart. Replay only moves the
        cursor. Drag the chart to pan, and drag the price scale to zoom.
        Dates and times are on the bottom axis. Volume is the histogram
        underneath. Script edits stay in this browser.
      </p>
    </main>
  );
}

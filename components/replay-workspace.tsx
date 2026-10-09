"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CandleChart } from "@/components/candle-chart";
import { ReplayTransport } from "@/components/replay-transport";
import { StrategyEditor } from "@/components/strategy-editor";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  FIXTURE_BARS,
  FIXTURE_NOTE,
  formatFixturePrice,
  formatFixtureTime,
} from "@/lib/fixture-bars";
import { scoreScript, type ScriptRun } from "@/lib/strategy-script";

const START_INDEX = 39;
const PLAY_MS = 180;

function formatR(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)} R`;
}

function formatPnl(value: number) {
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export function ReplayWorkspace() {
  const [index, setIndex] = useState(START_INDEX);
  const [playing, setPlaying] = useState(false);
  const [scriptRun, setScriptRun] = useState<ScriptRun | null>(null);
  const lastIndex = FIXTURE_BARS.length - 1;
  const toggleRef = useRef<() => void>(() => {});

  toggleRef.current = () => {
    if (!playing && index >= lastIndex) setIndex(0);
    setPlaying((current) => !current);
  };

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setIndex((current) => Math.min(lastIndex, current + 1));
    }, PLAY_MS);
    return () => window.clearInterval(timer);
  }, [playing, lastIndex]);

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

  const cursor = FIXTURE_BARS[index];
  const score = useMemo(() => {
    if (!scriptRun?.ok) return null;
    return scoreScript(scriptRun.trades, FIXTURE_BARS, index);
  }, [scriptRun, index]);
  const visibleMarkers = (scriptRun?.ok ? scriptRun.markers : [])
    .filter((marker) => marker.visibleFromIndex <= index)
    .map((marker) => ({
      ...marker,
      strategyId: "script",
      localIndex: marker.barIndex,
    }));
  const cursorLabel = formatFixtureTime(cursor.ts);
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
            <Badge variant="secondary">Synthetic fixture</Badge>
            <Badge variant={playing ? "default" : "outline"}>
              {playing ? "Playing" : "Paused"}
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {FIXTURE_NOTE} Drag the chart to pan. Drag the right price scale up
            or down to zoom. Scroll to zoom time. Replay only moves the cursor.
          </p>
        </div>
        <p className="font-mono text-sm text-foreground">{cursorLabel}</p>
      </header>

      <p className="sr-only" role="status">
        {playing ? "Playing" : "Paused"} at {cursorLabel}, bar {index + 1} of{" "}
        {FIXTURE_BARS.length}.
      </p>

      <div className="grid flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
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
            bars={FIXTURE_BARS}
            markers={visibleMarkers}
            cursorIndex={index}
          />
        </section>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Cursor bar</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="flex flex-col gap-2 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Symbol</dt>
                <dd className="font-mono text-xs">MNQ</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Timeframe</dt>
                <dd className="font-mono text-xs">1 minute</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Source</dt>
                <dd className="text-right text-xs">Synthetic fixture</dd>
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
                Script at cursor
              </p>
              {score ? (
                <dl className="flex flex-col gap-1 font-mono text-xs">
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
        count={FIXTURE_BARS.length}
        cursorLabel={cursorLabel}
        onToggle={toggle}
        onScrub={scrub}
        onStep={step}
        onJump={scrub}
      />

      <StrategyEditor onRun={setScriptRun} />

      <p className="text-xs text-muted-foreground">
        Space plays and pauses outside the editor. Drag the chart to pan, and
        drag the price scale to zoom. Dates and times are on the bottom axis.
        Volume is the histogram underneath. Script markers show after the
        cursor reaches them. Script edits stay in this browser.
      </p>
    </main>
  );
}

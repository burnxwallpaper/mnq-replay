"use client";

import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { FixtureBar } from "@/lib/fixture-bars";
import type { ChartMarker } from "@/lib/strategies/types";

const UP = "#3dd68c";
const DOWN = "#ef6b73";

function unix(ts: number): UTCTimestamp {
  return Math.floor(ts / 1000) as UTCTimestamp;
}

function timeToDate(time: Time): Date {
  if (typeof time === "number") return new Date(time * 1000);
  if (typeof time === "string") return new Date(time);
  return new Date(Date.UTC(time.year, time.month - 1, time.day));
}

function formatTick(time: Time) {
  const date = timeToDate(time);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(date);
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${day} ${clock}`;
}

export function CandleChart({
  bars,
  markers = [],
  cursorIndex = null,
  fitRevision = 0,
}: {
  bars: FixtureBar[];
  markers?: (ChartMarker & { localIndex: number })[];
  cursorIndex?: number | null;
  fitRevision?: number;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [span, setSpan] = useState("—");
  const [scale, setScale] = useState("—");

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    const chart = createChart(frame, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#12151c" },
        textColor: "#d5deea",
        fontSize: 12,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.06)" },
        horzLines: { color: "rgba(255,255,255,0.06)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: "#3a4658",
        minimumWidth: 84,
        scaleMargins: { top: 0.08, bottom: 0.28 },
      },
      timeScale: {
        borderColor: "#3a4658",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        tickMarkFormatter: (time: Time) => formatTick(time),
      },
      localization: {
        timeFormatter: (time: Time) => `${formatTick(time)} UTC`,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
        mouseWheel: true,
        pinch: true,
      },
    });

    const candles = chart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: { type: "price", precision: 2, minMove: 0.25 },
    });
    const volume = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    volume.priceScale().applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });
    candles.priceScale().applyOptions({
      scaleMargins: { top: 0.08, bottom: 0.28 },
    });

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;

    const readScales = () => {
      const range = chart.timeScale().getVisibleRange();
      if (range) {
        setSpan(`${formatTick(range.from)} → ${formatTick(range.to)} UTC`);
      }
      const pane = Math.max(40, frame.clientHeight - chart.timeScale().height());
      const hi = candles.coordinateToPrice(8);
      const lo = candles.coordinateToPrice(Math.round(pane * 0.68));
      if (hi != null && lo != null) {
        const top = Math.max(hi, lo);
        const bot = Math.min(hi, lo);
        setScale(`${bot.toFixed(2)} – ${top.toFixed(2)}`);
      }
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(readScales);
    frame.addEventListener("pointerup", readScales);
    frame.addEventListener("wheel", readScales, { passive: true });

    return () => {
      frame.removeEventListener("pointerup", readScales);
      frame.removeEventListener("wheel", readScales);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!chart || !candles || !volume || bars.length === 0) return;

    candles.setData(
      bars.map((bar) => ({
        time: unix(bar.ts),
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
      })),
    );
    const histogram: HistogramData[] = bars.map((bar) => ({
      time: unix(bar.ts),
      value: bar.v,
      color: bar.c >= bar.o ? "rgba(61,214,140,0.8)" : "rgba(239,107,115,0.8)",
    }));
    volume.setData(histogram);
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, bars.length - 110),
      to: bars.length + 3,
    });
  }, [bars]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || fitRevision === 0 || bars.length === 0) return;
    chart.timeScale().setVisibleLogicalRange({
      from: -1,
      to: bars.length + 2,
    });
  }, [fitRevision, bars.length]);

  useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    const next: SeriesMarker<Time>[] = [];
    for (const marker of markers) {
      const bar = bars[marker.localIndex];
      if (!bar) continue;
      const exit = marker.kind === "exit";
      next.push({
        time: unix(bar.ts),
        position: exit ? "aboveBar" : "belowBar",
        color:
          marker.kind === "signal"
            ? "#e2b340"
            : marker.kind === "entry"
              ? UP
              : marker.win
                ? UP
                : DOWN,
        shape: exit ? "arrowDown" : "arrowUp",
      });
    }
    if (cursorIndex != null && bars[cursorIndex]) {
      next.push({
        time: unix(bars[cursorIndex].ts),
        position: "inBar",
        color: "#f4f7fb",
        shape: "circle",
      });
    }
    candles.setMarkers(next);
  }, [bars, markers, cursorIndex]);

  return (
    <div className="absolute inset-0">
      <div
        ref={frameRef}
        className="absolute inset-0"
        role="img"
        aria-label="MNQ 1-minute candlestick chart with volume. Drag the chart to pan. Drag the right price scale up or down to zoom."
      />
      <div className="pointer-events-none absolute top-8 right-24 z-10 text-right font-mono text-[11px] text-[#d5deea]">
        <div id="chart-time">{span}</div>
        <div id="chart-price">Price {scale}</div>
        <div className="text-[#9aa8b8]">Volume</div>
      </div>
    </div>
  );
}

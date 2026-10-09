"use client";

import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { ema } from "@/lib/ema";
import { formatFixturePrice, formatFixtureTime, type FixtureBar } from "@/lib/fixture-bars";
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

type TradeCallout = {
  key: string;
  x: number;
  y: number;
  labelY: number;
  text: string;
  color: string;
  textColor: string;
  align: "left" | "right";
};

function tradeVerb(kind: "entry" | "exit", side: "long" | "short" | undefined) {
  const selling = kind === "entry" ? side === "short" : side !== "short";
  return selling ? "Sell" : "Buy";
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
  const emaRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaHaloRef = useRef<ISeriesApi<"Line"> | null>(null);
  const [span, setSpan] = useState("—");
  const [scale, setScale] = useState("—");
  const [callouts, setCallouts] = useState<TradeCallout[]>([]);
  const [copyNote, setCopyNote] = useState("");
  const markersRef = useRef(markers);
  const barsRef = useRef(bars);
  const calloutSigRef = useRef("");
  markersRef.current = markers;
  barsRef.current = bars;

  const placeCallouts = () => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    const frame = frameRef.current;
    if (!chart || !candles || !frame) return;
    const width = frame.clientWidth;
    const height = frame.clientHeight;
    const placed: TradeCallout[] = [];
    const occupied: { x: number; y: number }[] = [];
    for (const marker of markersRef.current) {
      if (marker.kind !== "entry" && marker.kind !== "exit") continue;
      if (typeof marker.price !== "number") continue;
      const bar = barsRef.current[marker.localIndex];
      if (!bar) continue;
      const xRaw = chart.timeScale().timeToCoordinate(unix(bar.ts));
      const yRaw = candles.priceToCoordinate(marker.price);
      if (xRaw == null || yRaw == null) continue;
      const x = Number(xRaw);
      const y = Number(yRaw);
      if (x < 8 || x > width - 8 || y < 8 || y > height - 8) continue;
      if (
        occupied.length >= 48 &&
        occupied.some((item) => Math.abs(item.x - x) < 18 && Math.abs(item.y - y) < 12)
      ) {
        continue;
      }
      occupied.push({ x, y });
      const color = marker.kind === "entry" || marker.win ? UP : DOWN;
      const buyEntry = marker.kind === "entry" && marker.side !== "short";
      placed.push({
        key: `${marker.kind}-${marker.localIndex}`,
        x,
        y,
        labelY: y,
        text: `${tradeVerb(marker.kind, marker.side)} ${formatFixturePrice(marker.price)}`,
        color,
        textColor: buyEntry ? "#ffffff" : color,
        align: x > width - 168 ? "right" : "left",
      });
    }
    const signature = placed
      .map(
        (item) =>
          `${item.key}:${Math.round(item.x)}:${Math.round(item.y)}:${Math.round(item.labelY)}:${item.align}`,
      )
      .join("|");
    if (signature === calloutSigRef.current) return;
    calloutSigRef.current = signature;
    setCallouts(placed);
  };
  const placeRef = useRef(placeCallouts);
  placeRef.current = placeCallouts;

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
    const emaHalo = chart.addLineSeries({
      color: "#071018",
      lineWidth: 4,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const emaLine = chart.addLineSeries({
      color: "#39d0ff",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      title: "EMA 5",
    });

    chartRef.current = chart;
    candleRef.current = candles;
    volumeRef.current = volume;
    emaHaloRef.current = emaHalo;
    emaRef.current = emaLine;

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
      placeRef.current();
    };

    const copyTimer = { id: 0 };
    const onChartClick = (param: MouseEventParams) => {
      if (!param.point || param.logical == null) return;
      const index = Math.round(Number(param.logical));
      const bar = barsRef.current[index];
      if (!bar) return;
      const yPrice = candles.coordinateToPrice(param.point.y);
      const lines = [
        formatFixtureTime(bar.ts),
        `O ${formatFixturePrice(bar.o)}`,
        `H ${formatFixturePrice(bar.h)}`,
        `L ${formatFixturePrice(bar.l)}`,
        `C ${formatFixturePrice(bar.c)}`,
        `V ${bar.v.toLocaleString("en-US")}`,
      ];
      if (yPrice != null) lines.push(`Price ${formatFixturePrice(Number(yPrice))}`);
      const text = lines.join("\n");
      void navigator.clipboard.writeText(text).then(
        () => {
          setCopyNote("Copied");
          window.clearTimeout(copyTimer.id);
          copyTimer.id = window.setTimeout(() => setCopyNote(""), 1600);
        },
        () => setCopyNote("Copy failed"),
      );
    };

    chart.subscribeClick(onChartClick);
    chart.timeScale().subscribeVisibleLogicalRangeChange(readScales);
    frame.addEventListener("pointermove", readScales);
    frame.addEventListener("pointerup", readScales);
    frame.addEventListener("wheel", readScales, { passive: true });

    return () => {
      window.clearTimeout(copyTimer.id);
      chart.unsubscribeClick(onChartClick);
      frame.removeEventListener("pointermove", readScales);
      frame.removeEventListener("pointerup", readScales);
      frame.removeEventListener("wheel", readScales);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      emaHaloRef.current = null;
      emaRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    const volume = volumeRef.current;
    const emaLine = emaRef.current;
    const emaHalo = emaHaloRef.current;
    if (!chart || !candles || !volume || !emaLine || !emaHalo || bars.length === 0) return;

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
    const emaValues = ema(
      bars.map((bar) => bar.c),
      5,
    );
    const emaData: LineData[] = [];
    for (let index = 0; index < bars.length; index += 1) {
      const value = emaValues[index];
      if (value === null) continue;
      emaData.push({ time: unix(bars[index].ts), value });
    }
    emaHalo.setData(emaData);
    emaLine.setData(emaData);
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
    placeRef.current();
    const frame = requestAnimationFrame(() => placeRef.current());
    return () => cancelAnimationFrame(frame);
  }, [bars, markers, cursorIndex]);

  return (
    <div className="absolute inset-0">
      <div
        ref={frameRef}
        className="absolute inset-0"
        role="img"
        aria-label="MNQ 1-minute candlestick chart with volume and a 5 EMA. Drag the chart to pan. Drag the right price scale up or down to zoom."
      />
      <div id="trade-callouts" className="pointer-events-none absolute inset-0 z-20">
        {callouts.map((callout) => (
          <div key={callout.key} data-trade-label={callout.text}>
            <span
              className="absolute"
              style={{
                left: callout.align === "right" ? callout.x - 40 : callout.x,
                top: callout.y,
                width: 40,
                height: 2,
                background: callout.color,
                transform: "translateY(-1px)",
              }}
            />
            <span
              className="absolute rounded-sm px-1 font-mono text-[10px] leading-4"
              style={{
                left: callout.align === "right" ? callout.x - 44 : callout.x + 44,
                top: callout.labelY,
                color: callout.textColor,
                background: "rgba(18,21,28,0.88)",
                boxShadow: `inset 0 0 0 1px ${callout.color}`,
                transform:
                  callout.align === "right"
                    ? "translate(-100%, -50%)"
                    : "translateY(-50%)",
              }}
            >
              {callout.text}
            </span>
          </div>
        ))}
      </div>
      <div className="pointer-events-none absolute top-8 right-24 z-10 text-right font-mono text-[11px] text-[#d5deea]">
        <div id="chart-time">{span}</div>
        <div id="chart-price">Price {scale}</div>
        <div className="text-[#9aa8b8]">Volume</div>
        <div id="chart-copy">{copyNote}</div>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import {
  formatFixtureClock,
  formatFixturePrice,
  type FixtureBar,
} from "@/lib/fixture-bars";
import type { ChartMarker } from "@/lib/strategies/types";

const UP = "oklch(0.78 0.15 155)";
const DOWN = "oklch(0.7 0.18 22)";
const GRID = "oklch(1 0 0 / 8%)";
const AXIS = "oklch(0.74 0.02 255)";

export function CandleChart({
  bars,
  markers = [],
}: {
  bars: FixtureBar[];
  markers?: (ChartMarker & { localIndex: number })[];
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 480 });

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({
        width: Math.max(280, Math.floor(width)),
        height: Math.max(240, Math.floor(height)),
      });
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const pad = { top: 16, right: 76, bottom: 28, left: 12 };
  const plotWidth = Math.max(1, size.width - pad.left - pad.right);
  const plotHeight = Math.max(1, size.height - pad.top - pad.bottom);
  const low = Math.min(...bars.map((bar) => bar.l));
  const high = Math.max(...bars.map((bar) => bar.h));
  const span = Math.max(high - low, 0.25);
  const min = low - span * 0.12;
  const max = high + span * 0.12;
  const yFor = (price: number) =>
    pad.top + ((max - price) / (max - min)) * plotHeight;
  const slot = plotWidth / bars.length;
  const ticks = [0, 1, 2, 3, 4].map((step) => min + ((max - min) * step) / 4);
  const timeMarks = [
    0,
    Math.floor((bars.length - 1) / 2),
    bars.length - 1,
  ].filter((index, position, all) => all.indexOf(index) === position);
  const last = bars[bars.length - 1];
  const lastUp = last.c >= last.o;

  return (
    <div ref={frameRef} className="absolute inset-0">
      <svg
        width={size.width}
        height={size.height}
        role="img"
        aria-label="Synthetic 1-minute candlestick replay"
        className="block"
      >
        {ticks.map((price) => {
          const y = yFor(price);
          return (
            <g key={price}>
              <line
                x1={pad.left}
                x2={size.width - pad.right}
                y1={y}
                y2={y}
                stroke={GRID}
              />
              <text
                x={size.width - 8}
                y={y + 4}
                fill={AXIS}
                fontSize="11"
                textAnchor="end"
                fontFamily="ui-monospace, SFMono-Regular, monospace"
              >
                {formatFixturePrice(price)}
              </text>
            </g>
          );
        })}
        {bars.map((bar, index) => {
          const up = bar.c >= bar.o;
          const color = up ? UP : DOWN;
          const x = pad.left + slot * index + slot / 2;
          const bodyWidth = Math.max(1.5, Math.min(14, slot * 0.62));
          const top = yFor(Math.max(bar.o, bar.c));
          const bottom = yFor(Math.min(bar.o, bar.c));
          const current = index === bars.length - 1;
          return (
            <g key={bar.ts}>
              <line
                x1={x}
                x2={x}
                y1={yFor(bar.h)}
                y2={yFor(bar.l)}
                stroke={color}
                strokeWidth={current ? 1.6 : 1}
              />
              <rect
                x={x - bodyWidth / 2}
                y={top}
                width={bodyWidth}
                height={Math.max(1, bottom - top)}
                fill={color}
                stroke={current ? "oklch(0.95 0.01 255)" : "none"}
                strokeWidth={current ? 1 : 0}
              />
            </g>
          );
        })}
        <line
          x1={pad.left}
          x2={size.width - pad.right}
          y1={yFor(last.c)}
          y2={yFor(last.c)}
          stroke={lastUp ? UP : DOWN}
          strokeDasharray="3 4"
          strokeOpacity={0.7}
        />
        {markers.map((marker) => {
          const bar = bars[marker.localIndex];
          if (!bar) return null;
          const x = pad.left + slot * marker.localIndex + slot / 2;
          const up = marker.kind !== "exit";
          const y = up ? yFor(bar.l) + 12 : yFor(bar.h) - 12;
          const color =
            marker.kind === "signal"
              ? "oklch(0.84 0.14 88)"
              : marker.kind === "entry"
                ? UP
                : marker.win
                  ? UP
                  : DOWN;
          const points = up
            ? `${x},${y - 6} ${x - 5},${y + 5} ${x + 5},${y + 5}`
            : `${x},${y + 6} ${x - 5},${y - 5} ${x + 5},${y - 5}`;
          return (
            <polygon
              key={`${marker.strategyId}-${marker.kind}-${marker.barIndex}`}
              data-marker={marker.kind}
              points={points}
              fill={color}
            >
              <title>
                {marker.kind === "signal"
                  ? "Signal"
                  : marker.kind === "entry"
                    ? "Entry"
                    : marker.win
                      ? "Target"
                      : "Stop"}
              </title>
            </polygon>
          );
        })}
        {timeMarks.map((index) => (
          <text
            key={bars[index].ts}
            x={pad.left + slot * index + slot / 2}
            y={size.height - 8}
            fill={AXIS}
            fontSize="11"
            textAnchor="middle"
            fontFamily="ui-monospace, SFMono-Regular, monospace"
          >
            {formatFixtureClock(bars[index].ts)}
          </text>
        ))}
      </svg>
    </div>
  );
}

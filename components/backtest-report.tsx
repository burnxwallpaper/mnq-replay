"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { equityAt, equityAxisTicks, equityYLabels, equityYOf } from "@/lib/equity-axis";
import { formatFixtureTime } from "@/lib/fixture-bars";
import type {
  BacktestStats,
  EquityPoint,
  EquitySeries,
  MultiBacktestReport,
} from "@/lib/strategy-script";
import { STARTING_NET_ASSET } from "@/lib/strategy-script";

const CHART_WIDTH = 640;
const CHART_PAD_X = 6;
const CHART_PAD_Y = 10;
const PLOT_BOTTOM = 148;
const CHART_HEIGHT = 168;

/** Absolute net-asset dollars (no forced +). */
function formatAsset(value: number) {
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPnl(value: number) {
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatPercent(value: number) {
  const pct = Math.round(value * 1000) / 10;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

function formatRr(value: number) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toFixed(2)} R`;
}

function formatHold(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

function formatMinutes(ms: number) {
  const minutes = ms / 60_000;
  if (minutes >= 10) return `${Math.round(minutes)} min`;
  return `${minutes.toFixed(1)} min`;
}

function linePath(
  points: EquityPoint[],
  xOf: (ts: number) => number,
  yOf: (value: number) => number,
) {
  const first = points[0];
  if (!first) return "";
  let line = `M ${xOf(first.ts).toFixed(1)} ${yOf(first.equity).toFixed(1)}`;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    line += ` H ${xOf(point.ts).toFixed(1)} V ${yOf(point.equity).toFixed(1)}`;
  }
  return line;
}

function EquityGraph({ series }: { series: EquitySeries[] }) {
  const width = CHART_WIDTH;
  const height = CHART_HEIGHT;
  const padX = CHART_PAD_X;
  const padY = CHART_PAD_Y;
  const plotBottom = PLOT_BOTTOM;
  const frameRef = useRef<HTMLDivElement>(null);
  const [innerPx, setInnerPx] = useState(280);
  const [hover, setHover] = useState<{
    ts: number;
    x: number;
    rows: { id: string; name: string; color: string; value: number }[];
  } | null>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const scale = frame.clientWidth / width;
      const next = Math.max(0, (width - padX * 2) * scale);
      setInnerPx((prev) => (Math.abs(prev - next) < 1 ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [padX, width]);

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let t0 = Number.POSITIVE_INFINITY;
  let t1 = Number.NEGATIVE_INFINITY;
  for (const item of series) {
    for (const point of item.equity) {
      if (point.equity < min) min = point.equity;
      if (point.equity > max) max = point.equity;
      if (point.ts < t0) t0 = point.ts;
      if (point.ts > t1) t1 = point.ts;
    }
  }
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) {
    t0 = 0;
    t1 = 0;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = STARTING_NET_ASSET - 1;
    max = STARTING_NET_ASSET + 1;
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = t1 - t0;
  const xOf = (ts: number) =>
    span <= 0 ? padX : padX + ((ts - t0) / span) * (width - padX * 2);
  // Keep labels on the same horizontal as plotted extremes (see equityYOf).
  const yOf = (value: number) => equityYOf(value, min, max, padY, plotBottom);
  const yLabels = equityYLabels(min, max, padY, plotBottom);
  const baselineY = yOf(STARTING_NET_ASSET);
  const primary = series.find((item) => item.id === "combined") ?? series[0];
  const areaLine = primary ? linePath(primary.equity, xOf, yOf) : "";
  const area =
    primary && primary.equity.length > 0 && areaLine
      ? `${areaLine} L ${xOf(primary.equity[primary.equity.length - 1].ts).toFixed(1)} ${baselineY.toFixed(1)} L ${xOf(primary.equity[0].ts).toFixed(1)} ${baselineY.toFixed(1)} Z`
      : "";
  const ticks = equityAxisTicks(t0, t1, innerPx);

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const inner = width - padX * 2;
    const fraction = inner <= 0 ? 0 : (x - padX) / inner;
    const clamped = Math.min(1, Math.max(0, fraction));
    const raw = t0 + clamped * span;
    const snapped =
      span <= 0 ? t0 : Math.min(t1, Math.max(t0, Math.round(raw / 60_000) * 60_000));
    const rows: { id: string; name: string; color: string; value: number }[] = [];
    for (const item of series) {
      const value = equityAt(item.equity, snapped);
      if (value === null) continue;
      rows.push({ id: item.id, name: item.name, color: item.color, value });
    }
    setHover((prev) => (prev && prev.ts === snapped ? prev : { ts: snapped, x: xOf(snapped), rows }));
  };

  return (
    <div ref={frameRef} id="equity-chart-frame" className="relative">
      <svg
        id="equity-chart"
        viewBox={`0 0 ${width} ${height}`}
        className="h-44 w-full cursor-crosshair"
        role="img"
        aria-label={`Net asset curves ending ${formatAsset(primary?.endingEquity ?? STARTING_NET_ASSET)}`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
      >
        <line
          x1={padX}
          x2={width - padX}
          y1={baselineY}
          y2={baselineY}
          stroke="rgba(213,222,234,0.35)"
          strokeDasharray="3 3"
        />
        <line
          x1={padX}
          x2={width - padX}
          y1={plotBottom}
          y2={plotBottom}
          stroke="rgba(213,222,234,0.28)"
        />
        {ticks.map((tick) => (
          <line
            key={`tick-${tick.ts}`}
            x1={xOf(tick.ts)}
            x2={xOf(tick.ts)}
            y1={plotBottom}
            y2={plotBottom + 4}
            stroke="rgba(154,168,184,0.7)"
          />
        ))}
        {area ? <path d={area} fill={primary?.color ?? "#3dd68c"} opacity={0.12} /> : null}
        {series.map((item) => {
          const d = linePath(item.equity, xOf, yOf);
          if (!d) return null;
          return (
            <path
              key={item.id}
              id={`equity-line-${item.id}`}
              d={d}
              fill="none"
              stroke={item.color}
              strokeWidth={item.id === "combined" ? 2.4 : 2}
              strokeDasharray={item.id === "combined" ? "6 3" : undefined}
            />
          );
        })}
        {hover ? (
          <line
            x1={hover.x}
            x2={hover.x}
            y1={padY}
            y2={plotBottom}
            stroke="rgba(213,222,234,0.7)"
            strokeDasharray="2 2"
          />
        ) : null}
        {yLabels.map((label) => (
          <text
            key={`y-${label.value}`}
            x={padX}
            y={label.y}
            dominantBaseline="middle"
            fill="#9aa8b8"
            fontSize={11}
            fontFamily="ui-monospace, monospace"
          >
            {formatAsset(label.value)}
          </text>
        ))}
      </svg>
      <div className="pointer-events-none absolute inset-x-0 bottom-0.5">
        {ticks.map((tick) => {
          const left = ((padX + tick.fraction * (width - padX * 2)) / width) * 100;
          const translate =
            tick.align === "start" ? "0" : tick.align === "end" ? "-100%" : "-50%";
          return (
            <span
              key={`${tick.align}-${tick.ts}`}
              className="absolute bottom-0 font-mono text-[11px] leading-none whitespace-nowrap text-[#9aa8b8]"
              style={{ left: `${left}%`, transform: `translateX(${translate})` }}
            >
              {tick.label}
            </span>
          );
        })}
      </div>
      {hover ? (
        <div
          id="equity-hover"
          className="pointer-events-none absolute top-1 right-1 z-10 max-w-[min(100%,28rem)] rounded-sm bg-[rgba(18,21,28,0.88)] px-2 py-1 font-mono text-[11px] leading-4 text-[#d5deea] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
        >
          <div id="equity-hover-time" className="text-[#9aa8b8]">
            {formatFixtureTime(hover.ts)}
          </div>
          {hover.rows.map((row) => (
            <div key={row.id}>
              <span style={{ color: row.color }}>{row.name}</span> {formatAsset(row.value)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  id,
  label,
  value,
}: {
  id: string;
  label: string;
  value: string;
}) {
  return (
    <div id={id} className="rounded-lg bg-foreground/5 px-3 py-2">
      <dt className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-1 font-mono text-sm">{value}</dd>
    </div>
  );
}

function AssetSummary({
  idPrefix,
  name,
  color,
  finalAsset,
  peak,
  trough,
}: {
  idPrefix: string;
  name: string;
  color?: string;
  finalAsset: number;
  peak: number;
  trough: number;
}) {
  return (
    <div id={`${idPrefix}-asset-summary`} className="flex flex-col gap-2">
      <h3
        className="font-mono text-xs tracking-wide uppercase"
        style={color ? { color } : undefined}
      >
        {name}
      </h3>
      <dl className="grid grid-cols-3 gap-2">
        <Stat id={`${idPrefix}-final-asset`} label="Final asset" value={formatAsset(finalAsset)} />
        <Stat id={`${idPrefix}-peak-asset`} label="Hist. high" value={formatAsset(peak)} />
        <Stat id={`${idPrefix}-trough-asset`} label="Hist. low" value={formatAsset(trough)} />
      </dl>
    </div>
  );
}

function StatsGrid({ stats, idPrefix }: { stats: BacktestStats; idPrefix: string }) {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <Stat
        id={`${idPrefix}-win-rate`}
        label="Win rate"
        value={stats.winRate === null ? "—" : formatPercent(stats.winRate)}
      />
      <Stat
        id={`${idPrefix}-avg-rr`}
        label="Avg RR ratio"
        value={stats.averageRr === null ? "—" : formatRr(stats.averageRr)}
      />
      <Stat
        id={`${idPrefix}-trade-count`}
        label="Trade count"
        value={String(stats.closedTrades)}
      />
      <Stat
        id={`${idPrefix}-total-fees`}
        label="Total fees"
        value={formatPnl(-stats.totalFees)}
      />
      <Stat
        id={`${idPrefix}-max-wins`}
        label="Max consecutive wins"
        value={String(stats.maxConsecutiveWins)}
      />
      <Stat
        id={`${idPrefix}-max-losses`}
        label="Max consecutive losses"
        value={String(stats.maxConsecutiveLosses)}
      />
      <Stat
        id={`${idPrefix}-max-drawdown`}
        label="Max drawdown"
        value={formatPnl(-stats.maxDrawdown)}
      />
      <Stat
        id={`${idPrefix}-avg-hold`}
        label="Average holding time"
        value={stats.averageHoldMs === null ? "—" : formatHold(stats.averageHoldMs)}
      />
      <Stat
        id={`${idPrefix}-longest-hold`}
        label="Longest holding time"
        value={stats.longestHoldMs === null ? "—" : formatHold(stats.longestHoldMs)}
      />
      <Stat
        id={`${idPrefix}-median-hold`}
        label="Median holding time"
        value={stats.medianHoldMs === null ? "—" : formatHold(stats.medianHoldMs)}
      />
      <Stat
        id={`${idPrefix}-signal-frequency`}
        label="Signal frequency"
        value={
          stats.signalIntervalMs === null
            ? "—"
            : `every ${formatMinutes(stats.signalIntervalMs)} · ${stats.signalCount}`
        }
      />
    </dl>
  );
}

export function BacktestReport({ report }: { report: MultiBacktestReport | null }) {
  if (!report) {
    return (
      <section
        id="backtest-report"
        aria-label="Equity and backtest stats"
        className="rounded-xl bg-[oklch(0.145_0.016_255)] px-3 py-3 ring-1 ring-foreground/10"
      >
        <p className="font-mono text-sm text-muted-foreground">
          Equity and stats appear after Apply strategy.
        </p>
      </section>
    );
  }

  const { series, stats, perStrategy } = report;
  const multi = perStrategy.length > 1;
  const combinedSeries = series.find((item) => item.id === "combined");

  return (
    <section
      id="backtest-report"
      aria-label="Equity and backtest stats"
      className="flex flex-col gap-3 rounded-xl bg-[oklch(0.145_0.016_255)] px-3 py-3 ring-1 ring-foreground/10"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-mono text-sm font-medium">Net asset</h2>
        <p id="equity-ending" className="font-mono text-sm">
          {formatAsset(stats.endingEquity)}
          <span className="text-muted-foreground">
            {" "}
            · start {formatAsset(STARTING_NET_ASSET)} · $2/pt · full period
          </span>
        </p>
      </div>
      <div
        id="equity-legend"
        className="flex flex-wrap gap-3 font-mono text-[11px] text-muted-foreground"
      >
        {series.map((item) => (
          <span key={item.id} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-0.5 w-3 rounded-full"
              style={{
                background: item.color,
                boxShadow: item.id === "combined" ? `0 0 0 1px ${item.color}` : undefined,
              }}
            />
            <span style={{ color: item.color }}>{item.name}</span>
            <span>{formatAsset(item.endingEquity)}</span>
          </span>
        ))}
      </div>
      <EquityGraph series={series} />

      <div id="asset-summaries" className="flex flex-col gap-3">
        {multi && combinedSeries ? (
          <AssetSummary
            idPrefix="stat-combined"
            name="Combined"
            color={combinedSeries.color}
            finalAsset={combinedSeries.endingEquity}
            peak={combinedSeries.peakEquity}
            trough={combinedSeries.troughEquity}
          />
        ) : null}
        {perStrategy.map((item) => (
          <AssetSummary
            key={item.id}
            idPrefix={multi ? `stat-${item.id}` : "stat"}
            name={item.name}
            color={item.color}
            finalAsset={item.stats.endingEquity}
            peak={item.stats.peakEquity}
            trough={item.stats.troughEquity}
          />
        ))}
      </div>

      {multi ? (
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="mb-2 font-mono text-xs tracking-wide text-muted-foreground uppercase">
              Combined stats
            </h3>
            <StatsGrid stats={stats} idPrefix="stat" />
          </div>
          {perStrategy.map((item) => (
            <div key={item.id} id={`stats-${item.id}`}>
              <h3
                className="mb-2 font-mono text-xs tracking-wide uppercase"
                style={{ color: item.color }}
              >
                {item.name} stats
              </h3>
              <StatsGrid stats={item.stats} idPrefix={`stat-${item.id}`} />
            </div>
          ))}
        </div>
      ) : (
        <StatsGrid stats={stats} idPrefix="stat" />
      )}
    </section>
  );
}

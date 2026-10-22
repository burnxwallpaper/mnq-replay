import type {
  BacktestStats,
  EquityPoint,
  EquitySeries,
  MultiBacktestReport,
} from "@/lib/strategy-script";

function formatPnl(value: number) {
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatPercent(value: number) {
  const pct = Math.round(value * 1000) / 10;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
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

function shortDate(ts: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(ts));
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
  const width = 640;
  const height = 148;
  const padX = 6;
  const padY = 10;
  let min = 0;
  let max = 0;
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
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = t1 - t0;
  const xOf = (ts: number) =>
    span <= 0 ? padX : padX + ((ts - t0) / span) * (width - padX * 2);
  const yOf = (value: number) =>
    padY + (1 - (value - min) / (max - min)) * (height - padY * 2);
  const zeroY = yOf(0);
  const primary = series.find((item) => item.id === "combined") ?? series[0];
  const areaLine = primary ? linePath(primary.equity, xOf, yOf) : "";
  const area =
    primary && primary.equity.length > 0 && areaLine
      ? `${areaLine} L ${xOf(primary.equity[primary.equity.length - 1].ts).toFixed(1)} ${zeroY.toFixed(1)} L ${xOf(primary.equity[0].ts).toFixed(1)} ${zeroY.toFixed(1)} Z`
      : "";

  return (
    <svg
      id="equity-chart"
      viewBox={`0 0 ${width} ${height}`}
      className="h-36 w-full"
      role="img"
      aria-label={`Equity curves ending ${formatPnl(primary?.endingEquity ?? 0)}`}
    >
      <line
        x1={padX}
        x2={width - padX}
        y1={zeroY}
        y2={zeroY}
        stroke="rgba(213,222,234,0.35)"
        strokeDasharray="3 3"
      />
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
      <text x={padX} y={12} fill="#9aa8b8" fontSize={11} fontFamily="ui-monospace, monospace">
        {formatPnl(max)}
      </text>
      <text
        x={padX}
        y={height - 2}
        fill="#9aa8b8"
        fontSize={11}
        fontFamily="ui-monospace, monospace"
      >
        {formatPnl(min)}
      </text>
    </svg>
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

function StatsGrid({ stats, idPrefix }: { stats: BacktestStats; idPrefix: string }) {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <Stat
        id={`${idPrefix}-win-rate`}
        label="Win rate"
        value={stats.winRate === null ? "—" : formatPercent(stats.winRate)}
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
        id={`${idPrefix}-shortest-hold`}
        label="Shortest holding time"
        value={stats.shortestHoldMs === null ? "—" : formatHold(stats.shortestHoldMs)}
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
  const start = stats.equity[0];
  const end = stats.equity[stats.equity.length - 1];
  const multi = perStrategy.length > 1;

  return (
    <section
      id="backtest-report"
      aria-label="Equity and backtest stats"
      className="flex flex-col gap-3 rounded-xl bg-[oklch(0.145_0.016_255)] px-3 py-3 ring-1 ring-foreground/10"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-mono text-sm font-medium">Equity</h2>
        <p id="equity-ending" className="font-mono text-sm">
          {formatPnl(stats.endingEquity)}
          <span className="text-muted-foreground"> · $2/point · full period</span>
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
            <span>{formatPnl(item.endingEquity)}</span>
          </span>
        ))}
      </div>
      <EquityGraph series={series} />
      <p className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{start ? shortDate(start.ts) : "—"}</span>
        <span>{end ? `${shortDate(end.ts)} UTC` : "—"}</span>
      </p>
      {multi ? (
        <div className="flex flex-col gap-4">
          <div>
            <h3 className="mb-2 font-mono text-xs tracking-wide text-muted-foreground uppercase">
              Combined
            </h3>
            <StatsGrid stats={stats} idPrefix="stat" />
          </div>
          {perStrategy.map((item) => (
            <div key={item.id} id={`stats-${item.id}`}>
              <h3
                className="mb-2 font-mono text-xs tracking-wide uppercase"
                style={{ color: item.color }}
              >
                {item.name}
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

import type { BacktestStats, EquityPoint } from "@/lib/strategy-script";

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

function formatFrequency(perDay: number) {
  if (perDay >= 10) return `${Math.round(perDay)} / day`;
  if (perDay >= 1) return `${perDay.toFixed(1)} / day`;
  return `${perDay.toFixed(2)} / day`;
}

function shortDate(ts: number) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(ts));
}

function EquityGraph({ points }: { points: EquityPoint[] }) {
  const width = 640;
  const height = 148;
  const padX = 6;
  const padY = 10;
  let min = 0;
  let max = 0;
  for (const point of points) {
    if (point.equity < min) min = point.equity;
    if (point.equity > max) max = point.equity;
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const t0 = points[0]?.ts ?? 0;
  const t1 = points[points.length - 1]?.ts ?? t0;
  const span = t1 - t0;
  const xOf = (ts: number) =>
    span <= 0 ? padX : padX + ((ts - t0) / span) * (width - padX * 2);
  const yOf = (value: number) =>
    padY + (1 - (value - min) / (max - min)) * (height - padY * 2);
  const first = points[0];
  const last = points[points.length - 1];
  let line = "";
  if (first) {
    line = `M ${xOf(first.ts).toFixed(1)} ${yOf(first.equity).toFixed(1)}`;
    for (let index = 1; index < points.length; index += 1) {
      const point = points[index];
      line += ` H ${xOf(point.ts).toFixed(1)} V ${yOf(point.equity).toFixed(1)}`;
    }
  }
  const up = (last?.equity ?? 0) >= 0;
  const stroke = up ? "#3dd68c" : "#ef6b73";
  const zeroY = yOf(0);
  const area =
    first && last
      ? `${line} L ${xOf(last.ts).toFixed(1)} ${zeroY.toFixed(1)} L ${xOf(first.ts).toFixed(1)} ${zeroY.toFixed(1)} Z`
      : "";

  return (
    <svg
      id="equity-chart"
      viewBox={`0 0 ${width} ${height}`}
      className="h-36 w-full"
      role="img"
      aria-label={`Equity curve ending ${formatPnl(last?.equity ?? 0)}`}
    >
      <line
        x1={padX}
        x2={width - padX}
        y1={zeroY}
        y2={zeroY}
        stroke="rgba(213,222,234,0.35)"
        strokeDasharray="3 3"
      />
      {area ? <path d={area} fill={stroke} opacity={0.16} /> : null}
      {line ? <path d={line} fill="none" stroke={stroke} strokeWidth={2} /> : null}
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

export function BacktestReport({ stats }: { stats: BacktestStats | null }) {
  if (!stats) {
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

  const start = stats.equity[0];
  const end = stats.equity[stats.equity.length - 1];

  return (
    <section
      id="backtest-report"
      aria-label="Equity and backtest stats"
      className="flex flex-col gap-3 rounded-xl bg-[oklch(0.145_0.016_255)] px-3 py-3 ring-1 ring-foreground/10"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-mono text-sm font-medium">Equity</h2>
        <p id="equity-ending" className="font-mono text-sm">
          {formatPnl(stats.endingEquity)}
          <span className="text-muted-foreground"> · $2/point · full period</span>
        </p>
      </div>
      <EquityGraph points={stats.equity} />
      <p className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{start ? shortDate(start.ts) : "—"}</span>
        <span>{end ? `${shortDate(end.ts)} UTC` : "—"}</span>
      </p>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat
          id="stat-win-rate"
          label="Win rate"
          value={stats.winRate === null ? "—" : formatPercent(stats.winRate)}
        />
        <Stat
          id="stat-max-wins"
          label="Max consecutive wins"
          value={String(stats.maxConsecutiveWins)}
        />
        <Stat
          id="stat-max-losses"
          label="Max consecutive losses"
          value={String(stats.maxConsecutiveLosses)}
        />
        <Stat
          id="stat-max-drawdown"
          label="Max drawdown"
          value={formatPnl(-stats.maxDrawdown)}
        />
        <Stat
          id="stat-avg-hold"
          label="Average holding time"
          value={stats.averageHoldMs === null ? "—" : formatHold(stats.averageHoldMs)}
        />
        <Stat
          id="stat-signal-frequency"
          label="Signal frequency"
          value={
            stats.signalPerDay === null
              ? "—"
              : `${formatFrequency(stats.signalPerDay)} · ${stats.signalCount}`
          }
        />
      </dl>
    </section>
  );
}

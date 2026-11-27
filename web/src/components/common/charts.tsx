/**
 * Atelier Trade SVG Data Visualization Kit
 * ------------------------------------------------------------------
 * Lightweight, zero-dependency, responsive pure-SVG charts designed for
 * GlobalCRM's warm ivory & deep forest-emerald visual grammar:
 *  - AreaTrendChart: Smooth cubic area curve with hover inspection
 *  - MiniSparkline: Subtle KPI trend curve
 *  - DonutChart: Clean ring chart with center metric & legend
 *  - HealthRing: Circular 0-100 score gauge
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

/* ----------------------------- AreaTrendChart ----------------------------- */

export interface TrendPoint {
  label: string;
  value: number;
  subLabel?: string;
}

function buildSmoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

export function AreaTrendChart({
  data,
  unit = '',
  height = 176,
  emptyLabel = '暂无趋势数据',
  className,
}: {
  data: TrendPoint[];
  unit?: string;
  height?: number;
  emptyLabel?: string;
  className?: string;
}): React.JSX.Element {
  const [hoverIdx, setHoverIdx] = React.useState<number | null>(null);
  const gradId = React.useId();

  if (!data.length) {
    return (
      <div className={cn('flex items-center justify-center rounded-lg bg-surface/60 text-xs text-muted-foreground', className)} style={{ height }}>
        {emptyLabel}
      </div>
    );
  }

  const width = 620;
  const padL = 36;
  const padR = 16;
  const padT = 18;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxVal = Math.max(...data.map((d) => d.value), 1);
  const niceMax = maxVal <= 4 ? 4 : Math.ceil(maxVal * 1.15);
  const gridTicks = [0, 0.33, 0.66, 1].map((r) => Math.round(niceMax * r));

  const coords = data.map((d, idx) => {
    const x = data.length === 1 ? padL + plotW / 2 : padL + (idx / (data.length - 1)) * plotW;
    const y = padT + plotH - (d.value / niceMax) * plotH;
    return { x, y };
  });

  const linePath = buildSmoothPath(coords);
  const areaPath = coords.length > 1
    ? `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`
    : '';

  const activeIdx = hoverIdx ?? (data.length - 1);
  const activePoint = data[activeIdx];
  const activeCoord = coords[activeIdx];

  const labelStep = data.length <= 7 ? 1 : Math.ceil(data.length / 6);

  return (
    <div className={cn('relative w-full select-none', className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-label="趋势图表"
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--foreground))" stopOpacity="0.14" />
            <stop offset="100%" stopColor="hsl(var(--foreground))" stopOpacity="0.01" />
          </linearGradient>
        </defs>

        {/* Horizontal gridlines */}
        {gridTicks.map((tick, i) => {
          const y = padT + plotH - (tick / niceMax) * plotH;
          return (
            <g key={i}>
              <line
                x1={padL}
                y1={y}
                x2={width - padR}
                y2={y}
                stroke="hsl(var(--border))"
                strokeDasharray={i === 0 ? undefined : '3 3'}
                strokeWidth="1"
              />
              <text
                x={padL - 8}
                y={y + 3.5}
                textAnchor="end"
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {tick}
              </text>
            </g>
          );
        })}

        {/* Area fill */}
        {areaPath ? <path d={areaPath} fill={`url(#${gradId})`} /> : null}

        {/* Smooth curve */}
        <path
          d={linePath}
          fill="none"
          stroke="hsl(var(--primary))"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Active vertical guide */}
        {activeCoord ? (
          <line
            x1={activeCoord.x}
            y1={padT}
            x2={activeCoord.x}
            y2={padT + plotH}
            stroke="hsl(var(--primary) / 0.25)"
            strokeDasharray="3 3"
            strokeWidth="1"
          />
        ) : null}

        {/* Interactive nodes */}
        {coords.map((pt, idx) => {
          const isActive = idx === activeIdx;
          return (
            <g key={idx}>
              <circle
                cx={pt.x}
                cy={pt.y}
                r={isActive ? 4.5 : 2.5}
                fill={isActive ? 'hsl(var(--card))' : 'hsl(var(--primary))'}
                stroke="hsl(var(--primary))"
                strokeWidth={isActive ? 2.5 : 0}
                className="transition-all duration-150"
              />
              {/* Wide hit zone */}
              <rect
                x={pt.x - Math.max(12, plotW / Math.max(data.length * 2, 1))}
                y={padT}
                width={Math.max(24, plotW / Math.max(data.length, 1))}
                height={plotH + padB}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setHoverIdx(idx)}
              />
            </g>
          );
        })}

        {/* X axis labels */}
        {data.map((d, idx) => {
          if (idx !== 0 && idx !== data.length - 1 && idx % labelStep !== 0) return null;
          return (
            <text
              key={idx}
              x={coords[idx].x}
              y={height - 6}
              textAnchor={idx === 0 ? 'start' : idx === data.length - 1 ? 'end' : 'middle'}
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {d.label}
            </text>
          );
        })}
      </svg>

      {/* Crisp floating badge showing active point */}
      {activePoint ? (
        <div className="pointer-events-none absolute right-2 top-1 rounded-lg border border-border bg-card/95 px-2.5 py-1 text-right shadow-card backdrop-blur-sm">
          <div className="text-[10px] text-muted-foreground">{activePoint.label}</div>
          <div className="text-xs font-semibold tabular-nums text-foreground">
            {activePoint.value.toLocaleString('zh-CN')}
            {unit ? <span className="ml-0.5 font-normal text-muted-foreground">{unit}</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------- MiniSparkline ----------------------------- */

export function MiniSparkline({
  values,
  tone = 'emerald',
  className,
}: {
  values: number[];
  tone?: 'emerald' | 'sky' | 'amber' | 'gold';
  className?: string;
}): React.JSX.Element {
  const gradId = React.useId();
  const safeValues = values.length >= 2 ? values : [0, 0];
  const w = 96;
  const h = 30;
  const max = Math.max(...safeValues, 1);
  const min = Math.min(...safeValues, 0);
  const span = Math.max(max - min, 1);
  const pts = safeValues.map((v, i) => ({
    x: (i / (safeValues.length - 1)) * w,
    y: h - 3 - ((v - min) / span) * (h - 6),
  }));
  const d = buildSmoothPath(pts);
  const area = `${d} L ${w} ${h} L 0 ${h} Z`;
  const stroke = {
    emerald: 'hsl(var(--primary))',
    sky: 'hsl(var(--status-pending))',
    amber: 'hsl(var(--amber))',
    gold: 'hsl(var(--gold))',
  }[tone];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn('h-7 w-24 shrink-0 overflow-visible', className)} aria-hidden>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.24" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/* ----------------------------- DonutChart ----------------------------- */

export interface DonutSlice {
  label: string;
  value: number;
  pct?: number;
  color?: string;
}

const MONOCHROME_PALETTE = [
  'hsl(var(--foreground))',
  'hsl(40 6% 32%)',
  'hsl(38 5% 50%)',
  'hsl(38 6% 66%)',
  'hsl(38 8% 78%)',
  'hsl(38 10% 87%)',
];

export function DonutChart({
  slices,
  centerValue,
  centerLabel,
  size = 132,
  strokeWidth = 17,
  className,
}: {
  slices: DonutSlice[];
  centerValue: React.ReactNode;
  centerLabel?: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
}): React.JSX.Element {
  const total = slices.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className={cn('flex w-full min-w-0 flex-col items-center gap-3.5 sm:flex-row sm:items-center', className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} className="-rotate-90" width={size} height={size} role="img" aria-label={centerLabel || '分布图表'}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="hsl(var(--muted))"
            strokeWidth={strokeWidth}
          />
          {total > 0
            ? slices.map((slice, idx) => {
                const frac = Math.max(0, slice.value) / total;
                const dash = frac * circumference;
                const currentOffset = offset;
                offset += dash;
                return (
                  <circle
                    key={slice.label}
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke={slice.color ?? MONOCHROME_PALETTE[idx % MONOCHROME_PALETTE.length]}
                    strokeWidth={strokeWidth}
                    strokeDasharray={`${Math.max(0, dash - 1.5)} ${circumference}`}
                    strokeDashoffset={-currentOffset}
                    strokeLinecap="butt"
                    className="transition-all duration-300"
                  />
                );
              })
            : null}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-lg font-bold leading-none tracking-tight tabular-nums text-foreground">{centerValue}</span>
          {centerLabel ? <span className="mt-1 text-[10px] text-muted-foreground">{centerLabel}</span> : null}
        </div>
      </div>

      <ul className="min-w-0 flex-1 space-y-2 text-xs">
        {slices.map((slice, idx) => {
          const pct = slice.pct ?? (total > 0 ? Math.round((slice.value / total) * 100) : 0);
          return (
            <li key={slice.label} className="flex items-center justify-between gap-2.5">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: slice.color ?? MONOCHROME_PALETTE[idx % MONOCHROME_PALETTE.length] }}
                  aria-hidden
                />
                <span className="truncate font-medium text-foreground/85">{slice.label}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                <strong className="font-semibold text-foreground">{pct}%</strong>
                <span className="ml-1 text-[11px]">({slice.value})</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ----------------------------- HealthRing ----------------------------- */

export function HealthRing({
  score,
  label,
  size = 86,
  strokeWidth = 7,
  className,
}: {
  score: number;
  label?: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
}): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dash = (clamped / 100) * circumference;
  const strokeColor = clamped >= 70
    ? 'hsl(var(--primary))'
    : clamped >= 40
      ? 'hsl(var(--amber))'
      : 'hsl(var(--rose))';

  return (
    <div className={cn('relative inline-flex shrink-0 items-center justify-center', className)} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="-rotate-90" width={size} height={size} role="img" aria-label={`${label ?? '评分'} ${clamped}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={`${dash} ${circumference}`}
          strokeLinecap="round"
          className="transition-all duration-500"
        />
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-xl font-bold leading-none tracking-tight tabular-nums text-foreground">{clamped}</span>
        {label ? <span className="mt-1 text-[10px] font-medium text-muted-foreground">{label}</span> : null}
      </div>
    </div>
  );
}

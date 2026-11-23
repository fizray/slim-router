/**
 * Zero-dependency responsive interactive SVG charts + KPI primitives (mobile & desktop friendly).
 */
import { useId, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const RANGES = [
  { id: "1h", label: "1H" },
  { id: "24h", label: "24H" },
  { id: "7d", label: "7D" },
  { id: "30d", label: "30D" },
  { id: "90d", label: "90D" },
  { id: "all", label: "All" },
];

export function RangeSelector({ value, onChange }) {
  return (
    <div className="max-w-full overflow-x-auto pb-0.5">
      <TabsList className="h-9 sm:h-8">
        {RANGES.map((r) => (
          <TabsTrigger key={r.id} active={value === r.id} onClick={() => onChange(r.id)} className="px-2.5 sm:px-2.5">
            {r.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );
}

export function KpiCard({ title, value, sub, icon: Icon, accent }) {
  return (
    <Card>
      <CardContent className="p-3.5 sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] sm:text-[11px] font-medium uppercase tracking-wider text-muted-foreground truncate">{title}</span>
          {Icon && <Icon className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", accent)} />}
        </div>
        <div className={cn("mt-1.5 text-xl sm:text-2xl font-bold tracking-tight tabular-nums", accent)}>{value}</div>
        {sub && <div className="mt-1 text-[11px] text-muted-foreground truncate">{sub}</div>}
      </CardContent>
    </Card>
  );
}

export function SvgLineAreaChart({
  title,
  description,
  data = [],
  xKey = "bucket",
  series = [],
  height = 220,
  area = false,
  formatY = (v) => String(v),
}) {
  const [hoverIdx, setHoverIdx] = useState(null);

  const W = 680;
  const H = height;
  const pad = { top: 14, right: 16, bottom: 26, left: 48 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  let maxVal = 0;
  for (const row of data) {
    for (const s of series) {
      const v = Number(row?.[s.key] ?? 0);
      if (Number.isFinite(v) && v > maxVal) maxVal = v;
    }
  }
  if (maxVal <= 0) maxVal = 1;

  const xAt = (i) => (data.length <= 1 ? pad.left + plotW / 2 : pad.left + (i / (data.length - 1)) * plotW);
  const yAt = (v) => pad.top + plotH - (Math.max(0, Number(v || 0)) / maxVal) * plotH;
  const hoverRow = hoverIdx !== null && data[hoverIdx] ? data[hoverIdx] : null;

  return (
    <Card>
      <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription className="mt-0.5">{description}</CardDescription>}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
            No telemetry data in this time window yet.
          </div>
        ) : (
          <div className="relative">
            {hoverRow && (
              <div className="pointer-events-none absolute right-2 top-1 z-10 rounded-md border bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-md backdrop-blur">
                <div className="font-mono text-muted-foreground mb-1">{String(hoverRow[xKey] || "")}</div>
                {series.map((s) => (
                  <div key={s.key} className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                      {s.label}
                    </span>
                    <span className="font-mono font-semibold">{formatY(hoverRow[s.key] ?? 0)}</span>
                  </div>
                ))}
              </div>
            )}
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto overflow-visible" onMouseLeave={() => setHoverIdx(null)}>
              {[0, 0.25, 0.5, 0.75, 1].map((t) => {
                const y = pad.top + plotH * (1 - t);
                return (
                  <g key={t}>
                    <line x1={pad.left} x2={W - pad.right} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.08" />
                    <text x={pad.left - 6} y={y + 3} textAnchor="end" className="fill-muted-foreground text-[9px] font-mono">
                      {formatY(maxVal * t)}
                    </text>
                  </g>
                );
              })}

              {series.map((s) => {
                const pts = data.map((row, i) => `${xAt(i).toFixed(1)},${yAt(row[s.key]).toFixed(1)}`).join(" ");
                const areaPath = data.length > 1
                  ? `M ${xAt(0).toFixed(1)},${(pad.top + plotH).toFixed(1)} L ${pts.replace(/ /g, " L ")} L ${xAt(data.length - 1).toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`
                  : "";
                return (
                  <g key={s.key}>
                    {area && areaPath && <path d={areaPath} fill={s.color} fillOpacity="0.14" />}
                    {data.length > 1 && (
                      <polyline fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={pts} />
                    )}
                    {data.map((row, i) => {
                      const showDot = data.length <= 24 || hoverIdx === i;
                      if (!showDot) return null;
                      return (
                        <circle
                          key={i}
                          cx={xAt(i)}
                          cy={yAt(row[s.key])}
                          r={hoverIdx === i || data.length === 1 ? 4 : 2.5}
                          fill={s.color}
                        />
                      );
                    })}
                  </g>
                );
              })}

              {hoverIdx !== null && (
                <line
                  x1={xAt(hoverIdx)}
                  x2={xAt(hoverIdx)}
                  y1={pad.top}
                  y2={pad.top + plotH}
                  stroke="currentColor"
                  strokeOpacity="0.25"
                  strokeDasharray="3 3"
                />
              )}

              {data.map((row, i) => {
                const showLabel = data.length <= 6 || i === 0 || i === data.length - 1 || i % Math.ceil(data.length / 5) === 0;
                const sliceW = data.length > 1 ? plotW / (data.length - 1) : plotW;
                return (
                  <g key={i}>
                    {showLabel && (
                      <text x={xAt(i)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[9px] font-mono">
                        {String(row[xKey] || "").slice(-8)}
                      </text>
                    )}
                    <rect
                      x={xAt(i) - sliceW / 2}
                      y={pad.top}
                      width={Math.max(12, sliceW)}
                      height={plotH}
                      fill="transparent"
                      onMouseEnter={() => setHoverIdx(i)}
                      onClick={() => setHoverIdx((cur) => (cur === i ? null : i))}
                    />
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SvgBarChart({
  title,
  description,
  data = [],
  xKey = "label",
  valueKey = "value",
  color = "#3b82f6",
  height = 220,
  formatY = (v) => String(v),
}) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const W = 680;
  const H = height;
  const pad = { top: 14, right: 16, bottom: 32, left: 52 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const rawMax = Math.max(0, ...data.map((d) => Number(d?.[valueKey] || 0)));
  const maxVal = rawMax > 0 ? rawMax : 1;
  const slotW = data.length > 0 ? plotW / data.length : plotW;
  const barW = Math.min(42, Math.max(6, slotW * 0.65));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
            No data available.
          </div>
        ) : (
          <div className="relative">
            {hoverIdx !== null && data[hoverIdx] && (
              <div className="pointer-events-none absolute right-2 top-1 z-10 rounded-md border bg-popover/95 px-2.5 py-1 text-[11px] shadow-md">
                <span className="font-mono text-muted-foreground mr-2">{String(data[hoverIdx][xKey])}</span>
                <span className="font-mono font-semibold">{formatY(data[hoverIdx][valueKey])}</span>
              </div>
            )}
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" onMouseLeave={() => setHoverIdx(null)}>
              {[0, 0.5, 1].map((t) => {
                const y = pad.top + plotH * (1 - t);
                return (
                  <g key={t}>
                    <line x1={pad.left} x2={W - pad.right} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.08" />
                    <text x={pad.left - 6} y={y + 3} textAnchor="end" className="fill-muted-foreground text-[9px] font-mono">
                      {formatY(maxVal * t)}
                    </text>
                  </g>
                );
              })}
              {data.map((row, i) => {
                const v = Math.max(0, Number(row?.[valueKey] || 0));
                const bh = (v / maxVal) * plotH;
                const x = pad.left + i * slotW + (slotW - barW) / 2;
                const y = pad.top + plotH - bh;
                return (
                  <g
                    key={i}
                    onMouseEnter={() => setHoverIdx(i)}
                    onClick={() => setHoverIdx((cur) => (cur === i ? null : i))}
                  >
                    <rect
                      x={x}
                      y={y}
                      width={barW}
                      height={Math.max(2, bh)}
                      rx="3"
                      fill={color}
                      fillOpacity={hoverIdx === i ? 1 : 0.8}
                    />
                    <text x={x + barW / 2} y={H - 10} textAnchor="middle" className="fill-muted-foreground text-[9px] font-mono">
                      {String(row[xKey] || "").slice(0, 12)}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Multi-series Bar Chart supporting:
 * - mode="stacked": 1 bar segmented bottom-to-top (e.g. Cache Hit + Cache Miss, Success + Error, Spend + Saved)
 * - mode="overlap": 1 bar with layered overlapping metrics (e.g. Total Latency back bar + TTFT inner bar)
 */
export function SvgMultiBarChart({
  title,
  description,
  data = [],
  xKey = "bucket",
  series = [],
  mode = "stacked",
  height = 230,
  formatY = (v) => String(v),
  totalLabel = "Total",
  showTotal = true,
  extraTooltip,
}) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const clipPrefix = useId().replace(/:/g, "");

  const W = 680;
  const H = height;
  const pad = { top: 14, right: 16, bottom: 30, left: 54 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  let maxVal = 0;
  for (const row of data) {
    if (mode === "stacked") {
      let sum = 0;
      for (const s of series) {
        const v = Math.max(0, Number(row?.[s.key] ?? 0));
        if (Number.isFinite(v)) sum += v;
      }
      if (sum > maxVal) maxVal = sum;
    } else {
      for (const s of series) {
        const v = Math.max(0, Number(row?.[s.key] ?? 0));
        if (Number.isFinite(v) && v > maxVal) maxVal = v;
      }
    }
  }
  if (maxVal <= 0) maxVal = 1;

  const slotW = data.length > 0 ? plotW / data.length : plotW;
  const barW = Math.min(48, Math.max(8, slotW * 0.56));
  const hoverRow = hoverIdx !== null && data[hoverIdx] ? data[hoverIdx] : null;
  const hoverTotal = hoverRow && mode === "stacked"
    ? series.reduce((acc, s) => acc + Math.max(0, Number(hoverRow?.[s.key] ?? 0)), 0)
    : null;

  return (
    <Card>
      <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription className="mt-0.5">{description}</CardDescription>}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          {series.map((s, idx) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 rounded-[3px]"
                style={{
                  backgroundColor: s.color,
                  opacity: mode === "overlap" && idx === 0 ? (s.opacity ?? 0.35) : (s.opacity ?? 0.92),
                  border: mode === "overlap" && idx === 0 ? `1px solid ${s.color}` : "none",
                }}
              />
              {s.label}
            </span>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
            No telemetry data in this time window yet.
          </div>
        ) : (
          <div className="relative">
            {hoverRow && (
              <div className="pointer-events-none absolute right-2 top-1 z-10 min-w-[160px] rounded-md border bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-md backdrop-blur">
                <div className="font-mono text-muted-foreground mb-1">{String(hoverRow[xKey] || "")}</div>
                {series.map((s) => (
                  <div key={s.key} className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: s.color }} />
                      {s.label}
                    </span>
                    <span className="font-mono font-semibold">{formatY(hoverRow[s.key] ?? 0)}</span>
                  </div>
                ))}
                {mode === "stacked" && showTotal && series.length > 1 && (
                  <div className="mt-1 flex items-center justify-between gap-3 border-t pt-1 text-muted-foreground">
                    <span>{totalLabel}</span>
                    <span className="font-mono font-semibold text-foreground">{formatY(hoverTotal)}</span>
                  </div>
                )}
                {extraTooltip && extraTooltip(hoverRow) && (
                  <div className="mt-1 border-t pt-1 font-mono text-[10px] text-sky-500">
                    {extraTooltip(hoverRow)}
                  </div>
                )}
              </div>
            )}

            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto overflow-visible" onMouseLeave={() => setHoverIdx(null)}>
              {[0, 0.25, 0.5, 0.75, 1].map((t) => {
                const y = pad.top + plotH * (1 - t);
                return (
                  <g key={t}>
                    <line x1={pad.left} x2={W - pad.right} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.08" />
                    <text x={pad.left - 6} y={y + 3} textAnchor="end" className="fill-muted-foreground text-[9px] font-mono">
                      {formatY(maxVal * t)}
                    </text>
                  </g>
                );
              })}

              {data.map((row, i) => {
                const slotX = pad.left + i * slotW;
                const x = slotX + (slotW - barW) / 2;
                const isHovered = hoverIdx === i;
                const showLabel = data.length <= 8 || i === 0 || i === data.length - 1 || i % Math.ceil(data.length / 6) === 0;
                const rawLabel = String(row[xKey] || "");
                const shortLabel = rawLabel.length > 10 ? rawLabel.slice(-8) : rawLabel;

                if (mode === "overlap") {
                  return (
                    <g key={i}>
                      {isHovered && (
                        <rect x={slotX} y={pad.top} width={slotW} height={plotH} fill="currentColor" fillOpacity="0.04" rx="4" />
                      )}
                      {series.map((s, sIdx) => {
                        const v = Math.max(0, Number(row?.[s.key] ?? 0));
                        const bh = v > 0 ? Math.max(3, (v / maxVal) * plotH) : 0;
                        const y = pad.top + plotH - bh;
                        const isBack = sIdx === 0;
                        const inset = !isBack && barW >= 14 ? 3 : 0;
                        const w = barW - inset * 2;
                        const bx = x + inset;
                        return bh > 0 ? (
                          <rect
                            key={s.key}
                            x={bx}
                            y={y}
                            width={w}
                            height={bh}
                            rx={isBack ? "4" : "3"}
                            fill={s.color}
                            fillOpacity={isBack ? (isHovered ? 0.45 : (s.opacity ?? 0.3)) : (isHovered ? 1 : (s.opacity ?? 0.9))}
                            stroke={isBack ? s.color : "none"}
                            strokeWidth={isBack ? "1.25" : "0"}
                            strokeOpacity={isBack ? "0.7" : "0"}
                          />
                        ) : null;
                      })}
                      {showLabel && (
                        <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[9px] font-mono">
                          {shortLabel}
                        </text>
                      )}
                      <rect
                        x={slotX}
                        y={pad.top}
                        width={Math.max(12, slotW)}
                        height={plotH}
                        fill="transparent"
                        className="cursor-pointer"
                        onMouseEnter={() => setHoverIdx(i)}
                        onClick={() => setHoverIdx((cur) => (cur === i ? null : i))}
                      />
                    </g>
                  );
                }

                // Stacked mode: single bar segmented bottom-to-top with rounded outer clip
                const total = series.reduce((acc, s) => acc + Math.max(0, Number(row?.[s.key] ?? 0)), 0);
                const totalH = total > 0 ? Math.max(3, (total / maxVal) * plotH) : 0;
                const totalTopY = pad.top + plotH - totalH;
                const clipId = `${clipPrefix}-bar-${i}`;
                let currentY = pad.top + plotH;

                return (
                  <g key={i}>
                    {isHovered && (
                      <rect x={slotX} y={pad.top} width={slotW} height={plotH} fill="currentColor" fillOpacity="0.04" rx="4" />
                    )}
                    {totalH > 0 && (
                      <>
                        <defs>
                          <clipPath id={clipId}>
                            <rect x={x} y={totalTopY} width={barW} height={totalH} rx="4" />
                          </clipPath>
                        </defs>
                        <g clipPath={`url(#${clipId})`}>
                          {series.map((s) => {
                            const v = Math.max(0, Number(row?.[s.key] ?? 0));
                            if (v <= 0) return null;
                            const segH = (v / total) * totalH;
                            currentY -= segH;
                            return (
                              <rect
                                key={s.key}
                                x={x}
                                y={currentY}
                                width={barW}
                                height={Math.max(1, segH + 0.5)}
                                fill={s.color}
                                fillOpacity={isHovered ? 1 : (s.opacity ?? 0.88)}
                              />
                            );
                          })}
                        </g>
                      </>
                    )}
                    {showLabel && (
                      <text x={x + barW / 2} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[9px] font-mono">
                        {shortLabel}
                      </text>
                    )}
                    <rect
                      x={slotX}
                      y={pad.top}
                      width={Math.max(12, slotW)}
                      height={plotH}
                      fill="transparent"
                      className="cursor-pointer"
                      onMouseEnter={() => setHoverIdx(i)}
                      onClick={() => setHoverIdx((cur) => (cur === i ? null : i))}
                    />
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

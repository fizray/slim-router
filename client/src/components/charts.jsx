import { useEffect, useId, useRef, useState } from "react";
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

// Measure actual CSS pixel width so SVGs render 1:1 without viewBox font/bar scaling distortion.
function useContainerWidth(fallback = 640) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const next = Math.floor(el.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

function computeTickIndices(count, plotW, minPxGap = 62) {
  if (count <= 0) return new Set();
  if (count === 1) return new Set([0]);
  const slotW = plotW / count;
  const maxLabels = Math.max(2, Math.floor(plotW / minPxGap));
  if (count <= maxLabels) {
    return new Set(Array.from({ length: count }, (_, i) => i));
  }
  const step = Math.ceil(count / maxLabels);
  const picked = [0];
  for (let i = step; i < count - 1; i += step) {
    picked.push(i);
  }
  const lastPicked = picked[picked.length - 1];
  // Only append the final label if it has enough horizontal clearance from the previous tick.
  if ((count - 1 - lastPicked) * slotW >= minPxGap * 0.85) {
    picked.push(count - 1);
  }
  return new Set(picked);
}

function buildDeduplicatedYTicks(maxVal, fractions, formatY) {
  // Align small integer count axes (1..4) to exact integer gridlines instead of rounded quartiles.
  if (Number.isInteger(maxVal) && maxVal >= 1 && maxVal <= 4 && formatY(1) === "1") {
    return Array.from({ length: maxVal + 1 }, (_, k) => ({ t: k / maxVal, label: formatY(k) }));
  }
  const priority = [...fractions].sort((a, b) => {
    const rank = (t) => (t === 0 || t === 1 ? 0 : t === 0.5 ? 1 : 2);
    return rank(a) - rank(b) || a - b;
  });
  const seen = new Set();
  const out = [];
  for (const t of priority) {
    const label = formatY(maxVal * t);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ t, label });
  }
  return out.sort((a, b) => a.t - b.t);
}

export function RangeSelector({ value, onChange }) {
  return (
    <div className="max-w-full overflow-x-auto">
      <TabsList className="h-9 sm:h-8">
        {RANGES.map((r) => (
          <TabsTrigger key={r.id} active={value === r.id} onClick={() => onChange(r.id)} className="px-2.5">
            {r.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );
}

export function KpiCard({ title, value, sub, icon: Icon, accent, className }) {
  return (
    <Card className={className}>
      <CardContent className="p-3.5 sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground truncate">
            {title}
          </span>
          {Icon && <Icon className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground/80", accent)} />}
        </div>
        <div className={cn("mt-1.5 text-xl sm:text-[22px] font-semibold tracking-tight tabular-nums leading-none", accent)}>
          {value}
        </div>
        {sub && <div className="mt-1.5 text-[11px] text-muted-foreground tabular-nums truncate">{sub}</div>}
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
  legendLabel,
}) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const [containerRef, measuredW] = useContainerWidth(640);
  const W = Math.max(260, measuredW);
  const H = height;
  const pad = { top: 12, right: 12, bottom: 26, left: 52 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const rawMax = Math.max(0, ...data.map((d) => Number(d?.[valueKey] || 0)));
  const maxVal = rawMax > 0 ? rawMax : 1;
  const slotW = data.length > 0 ? plotW / data.length : plotW;
  const barW = Math.min(28, Math.max(6, Math.floor(slotW * 0.45)));
  const tickSet = computeTickIndices(data.length, plotW, 72);
  const yTicks = buildDeduplicatedYTicks(maxVal, [0, 0.25, 0.5, 0.75, 1], formatY);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription className="mt-0.5">{description}</CardDescription>}
          </div>
        </div>
        {legendLabel && (
          <div className="flex flex-wrap items-center gap-3 pt-1.5 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: color, opacity: 0.9 }} />
              {legendLabel}
            </span>
          </div>
        )}
      </CardHeader>
      <CardContent className="flex-1">
        <div ref={containerRef} className="w-full">
          {data.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
              No data recorded in this window.
            </div>
          ) : (
            <div className="relative">
              {hoverIdx !== null && data[hoverIdx] && (
                <div className="pointer-events-none absolute right-2 top-1 z-10 rounded-md border bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-md backdrop-blur">
                  <span className="font-mono text-muted-foreground mr-2">{String(data[hoverIdx][xKey])}</span>
                  <span className="font-mono font-semibold">{formatY(data[hoverIdx][valueKey])}</span>
                </div>
              )}
              <svg
                width={W}
                height={H}
                viewBox={`0 0 ${W} ${H}`}
                className="block w-full overflow-visible"
                style={{ height: H }}
                onMouseLeave={() => setHoverIdx(null)}
              >
                {yTicks.map(({ t, label }) => {
                  const y = pad.top + plotH * (1 - t);
                  return (
                    <g key={t}>
                      <line x1={pad.left} x2={W - pad.right} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.08" />
                      <text x={pad.left - 8} y={y + 3.5} textAnchor="end" fontSize="11" className="fill-muted-foreground font-mono">
                        {label}
                      </text>
                    </g>
                  );
                })}
                {data.map((row, i) => {
                  const v = Math.max(0, Number(row?.[valueKey] || 0));
                  const bh = v > 0 ? Math.max(3, (v / maxVal) * plotH) : 0;
                  const slotX = pad.left + i * slotW;
                  const x = slotX + (slotW - barW) / 2;
                  const y = pad.top + plotH - bh;
                  const isHovered = hoverIdx === i;
                  const rawLabel = String(row[xKey] || "");
                  const shortLabel = rawLabel.length > 14 ? rawLabel.slice(0, 14) : rawLabel;
                  return (
                    <g key={i}>
                      {isHovered && (
                        <rect x={slotX} y={pad.top} width={slotW} height={plotH} fill="currentColor" fillOpacity="0.04" rx="4" />
                      )}
                      {bh > 0 && (
                        <rect
                          x={x}
                          y={y}
                          width={barW}
                          height={bh}
                          rx="3"
                          fill={color}
                          fillOpacity={isHovered ? 1 : 0.86}
                        />
                      )}
                      {tickSet.has(i) && (
                        <text x={x + barW / 2} y={H - 6} textAnchor="middle" fontSize="11" className="fill-muted-foreground font-mono">
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
        </div>
      </CardContent>
    </Card>
  );
}

export function SvgMultiBarChart({
  title,
  description,
  data = [],
  xKey = "bucket",
  series = [],
  height = 220,
  formatY = (v) => String(v),
  totalLabel = "Total",
  showTotal = true,
  extraTooltip,
}) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const [containerRef, measuredW] = useContainerWidth(640);
  const clipPrefix = useId().replace(/:/g, "");

  const W = Math.max(260, measuredW);
  const H = height;
  const pad = { top: 12, right: 12, bottom: 26, left: 52 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  let maxVal = 0;
  for (const row of data) {
    let sum = 0;
    for (const s of series) {
      const v = Math.max(0, Number(row?.[s.key] ?? 0));
      if (Number.isFinite(v)) sum += v;
    }
    if (sum > maxVal) maxVal = sum;
  }
  if (maxVal <= 0) maxVal = 1;

  const slotW = data.length > 0 ? plotW / data.length : plotW;
  const barW = Math.min(28, Math.max(6, Math.floor(slotW * 0.45)));
  const tickSet = computeTickIndices(data.length, plotW, 72);
  const yTicks = buildDeduplicatedYTicks(maxVal, [0, 0.25, 0.5, 0.75, 1], formatY);
  const hoverRow = hoverIdx !== null && data[hoverIdx] ? data[hoverIdx] : null;
  const hoverTotal = hoverRow
    ? series.reduce((acc, s) => acc + Math.max(0, Number(hoverRow?.[s.key] ?? 0)), 0)
    : null;

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription className="mt-0.5">{description}</CardDescription>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 pt-1.5 text-[11px] text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 rounded-[3px] shrink-0"
                style={{
                  backgroundColor: s.color,
                  opacity: s.opacity ?? 0.9,
                }}
              />
              {s.label}
            </span>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        <div ref={containerRef} className="w-full">
          {data.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
              No telemetry data in this window.
            </div>
          ) : (
            <div className="relative">
              {hoverRow && (
                <div className="pointer-events-none absolute right-2 top-1 z-10 min-w-[168px] rounded-md border bg-popover/95 px-2.5 py-2 text-[11px] shadow-md backdrop-blur">
                  <div className="font-mono text-[10px] text-muted-foreground mb-1">{String(hoverRow[xKey] || "")}</div>
                  {series.map((s) => (
                    <div key={s.key} className="flex items-center justify-between gap-3 py-0.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: s.color }} />
                        {s.label}
                      </span>
                      <span className="font-mono font-semibold">{formatY(hoverRow[s.key] ?? 0)}</span>
                    </div>
                  ))}
                  {showTotal && series.length > 1 && (
                    <div className="mt-1 flex items-center justify-between gap-3 border-t pt-1 text-muted-foreground">
                      <span>{totalLabel}</span>
                      <span className="font-mono font-semibold text-foreground">{formatY(hoverTotal)}</span>
                    </div>
                  )}
                  {extraTooltip && extraTooltip(hoverRow) && (
                    <div className="mt-1 border-t pt-1 font-mono text-[10px] text-sky-600 dark:text-sky-400">
                      {extraTooltip(hoverRow)}
                    </div>
                  )}
                </div>
              )}

              <svg
                width={W}
                height={H}
                viewBox={`0 0 ${W} ${H}`}
                className="block w-full overflow-visible"
                style={{ height: H }}
                onMouseLeave={() => setHoverIdx(null)}
              >
                {yTicks.map(({ t, label }) => {
                  const y = pad.top + plotH * (1 - t);
                  return (
                    <g key={t}>
                      <line x1={pad.left} x2={W - pad.right} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.08" />
                      <text x={pad.left - 8} y={y + 3.5} textAnchor="end" fontSize="11" className="fill-muted-foreground font-mono">
                        {label}
                      </text>
                    </g>
                  );
                })}

                {data.map((row, i) => {
                  const slotX = pad.left + i * slotW;
                  const x = slotX + (slotW - barW) / 2;
                  const isHovered = hoverIdx === i;
                  const rawLabel = String(row[xKey] || "");
                  const shortLabel = rawLabel.length > 10 ? rawLabel.slice(-8) : rawLabel;

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
                              <rect x={x} y={totalTopY} width={barW} height={totalH} rx="3" />
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
                      {tickSet.has(i) && (
                        <text x={x + barW / 2} y={H - 6} textAnchor="middle" fontSize="11" className="fill-muted-foreground font-mono">
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
        </div>
      </CardContent>
    </Card>
  );
}

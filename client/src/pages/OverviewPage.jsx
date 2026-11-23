import { useState, useEffect, useCallback } from "react";
import { Activity, DollarSign, DatabaseZap, Gauge, AlertTriangle, RefreshCw, Layers, ArrowDownToLine, ArrowUpFromLine, Sparkles } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fmtNum, fmtUsd, fmtMs, fmtPct } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { KpiCard, RangeSelector, SvgMultiBarChart } from "@/components/charts";

export function OverviewPage() {
  const [range, setRange] = useState("24h");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiFetch(`/api/analytics/overview?range=${range}`));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const s = data?.summary || {};
  const ts = data?.timeseries || [];
  const topModels = data?.topModels || [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Executive Overview</h2>
          <p className="text-xs text-muted-foreground">Real-time traffic, token volume, cost, prompt caching, and latency across Vertex AI &amp; AI Studio</p>
        </div>
        <div className="flex items-center gap-2">
          <RangeSelector value={range} onChange={setRange} />
          <Button variant="outline" size="icon" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Primary Operational KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard title="Requests" value={fmtNum(s.totalRequests)} sub={`${fmtPct(s.successRatePct)} success`} icon={Activity} />
        <KpiCard title="Total Cost" value={fmtUsd(s.totalCostUsd)} sub={`No cache: ${fmtUsd(s.costWithoutCacheUsd)}`} icon={DollarSign} accent="text-emerald-500" />
        <KpiCard title="Cache Hit Ratio" value={fmtPct(s.cacheHitRatioPct)} sub={`Saved ${fmtUsd(s.netCacheSavingsUsd)}`} icon={DatabaseZap} accent="text-sky-500" />
        <KpiCard title="P95 Latency" value={fmtMs(s.p95LatencyMs)} sub={`TTFT p95: ${fmtMs(s.p95TtftMs)}`} icon={Gauge} />
        <KpiCard title="Errors" value={fmtNum(s.errorCount)} sub={`Failovers: ${fmtNum(s.failoverCount)}`} icon={AlertTriangle} accent={s.errorCount > 0 ? "text-amber-500" : ""} />
      </div>

      {/* Token Usage Flex Strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          title="Total Tokens"
          value={fmtNum(s.totalTokens)}
          sub={`${Number(s.totalTokens || 0).toLocaleString()} tokens`}
          icon={Layers}
        />
        <KpiCard
          title="Input (Uncached)"
          value={fmtNum(s.uncachedInputTokens)}
          sub={`${Number(s.uncachedInputTokens || 0).toLocaleString()} tokens`}
          icon={ArrowDownToLine}
          accent="text-blue-500"
        />
        <KpiCard
          title="Cached Tokens"
          value={fmtNum(s.cachedReadTokens)}
          sub={`${Number(s.cachedReadTokens || 0).toLocaleString()} tokens`}
          icon={Sparkles}
          accent="text-sky-500"
        />
        <KpiCard
          title="Output Tokens"
          value={fmtNum(s.completionTokens)}
          sub={`${Number(s.completionTokens || 0).toLocaleString()} tokens`}
          icon={ArrowUpFromLine}
          accent="text-emerald-500"
        />
      </div>

      {/* Token Usage Breakdown Stacked Bar */}
      <SvgMultiBarChart
        title="Token Usage Breakdown (Cached / Input / Output)"
        description="Stacked token volume per bucket — cached read hits, uncached input, and output tokens"
        data={ts}
        xKey="bucket"
        mode="stacked"
        totalLabel="Total Tokens"
        series={[
          { key: "cachedReadTokens", label: "Cached Read", color: "#0ea5e9" },
          { key: "uncachedInputTokens", label: "Input (Uncached)", color: "#3b82f6" },
          { key: "completionTokens", label: "Output", color: "#10b981" },
          { key: "cacheWriteTokens", label: "Cache Write", color: "#8b5cf6" },
        ]}
        formatY={(v) => fmtNum(Math.round(v))}
        extraTooltip={(row) => {
          const p = Number(row.promptTokens || 0);
          const hit = p > 0 ? (Number(row.cachedReadTokens || 0) / p) * 100 : 0;
          return `Cache Hit: ${fmtPct(hit)}`;
        }}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SvgMultiBarChart
          title="Request Volume & Errors"
          description="Stacked success vs error requests per bucket"
          data={ts}
          xKey="bucket"
          mode="stacked"
          totalLabel="Total Requests"
          series={[
            { key: "successRequests", label: "Success", color: "#3b82f6" },
            { key: "errors", label: "Errors", color: "#ef4444" },
          ]}
          formatY={(v) => fmtNum(Math.round(v))}
        />
        <SvgMultiBarChart
          title="Spend & Cache Savings (USD)"
          description="Actual spend + USD saved by prompt caching"
          data={ts}
          xKey="bucket"
          mode="stacked"
          totalLabel="Without Cache"
          series={[
            { key: "costUsd", label: "Actual Spend", color: "#10b981" },
            { key: "cacheSavingsUsd", label: "Cache Saved", color: "#06b6d4" },
          ]}
          formatY={(v) => fmtUsd(v, 3)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Top Models</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider / Model</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Cached</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Total Tokens</TableHead>
                <TableHead className="text-right">Cache Hit</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {topModels.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">No requests recorded yet.</TableCell></TableRow>
              ) : (
                topModels.map((m) => (
                  <TableRow key={`${m.provider}/${m.model}`}>
                    <TableCell className="font-mono whitespace-nowrap">
                      <Badge variant="secondary" className="mr-2">{m.provider}</Badge>
                      {m.model}
                    </TableCell>
                    <TableCell className="text-right font-mono">{fmtNum(m.requests)}</TableCell>
                    <TableCell className="text-right font-mono text-blue-500">{fmtNum(m.uncachedInputTokens ?? m.promptTokens)}</TableCell>
                    <TableCell className="text-right font-mono text-sky-500">{fmtNum(m.cachedReadTokens)}</TableCell>
                    <TableCell className="text-right font-mono text-emerald-500">{fmtNum(m.completionTokens)}</TableCell>
                    <TableCell className="text-right font-mono font-medium">{fmtNum(m.totalTokens)}</TableCell>
                    <TableCell className="text-right font-mono text-sky-500">{fmtPct(m.cacheHitRatioPct)}</TableCell>
                    <TableCell className="text-right font-mono font-medium">{fmtUsd(m.costUsd)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

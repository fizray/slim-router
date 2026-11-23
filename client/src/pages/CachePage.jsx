import { useState, useEffect, useCallback } from "react";
import { DatabaseZap, PiggyBank, Layers, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fmtNum, fmtUsd, fmtPct } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { KpiCard, RangeSelector, SvgMultiBarChart, SvgBarChart } from "@/components/charts";

export function CachePage() {
  const [range, setRange] = useState("24h");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiFetch(`/api/analytics/cache?range=${range}`));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const s = data?.summary || {};
  const ts = data?.timeseries || [];
  const models = data?.byModel || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Prompt Caching Efficiency</h2>
          <p className="text-xs text-muted-foreground">Canonical prompt token normalization (cached_read / total_prompt_tokens) and net USD cache savings</p>
        </div>
        <div className="flex items-center gap-2">
          <RangeSelector value={range} onChange={setRange} />
          <Button variant="outline" size="icon" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard title="Token Cache Hit Ratio" value={fmtPct(s.tokenCacheHitRatioPct)} sub={`${fmtNum(s.cachedReadTokens)} / ${fmtNum(s.promptTokens)} tokens`} icon={DatabaseZap} accent="text-sky-500" />
        <KpiCard title="Request Cache Hit Rate" value={fmtPct(s.requestCacheHitRatePct)} sub="Requests with cached_read > 0" icon={Layers} />
        <KpiCard title="Net Cache Savings" value={fmtUsd(s.netCacheSavingsUsd)} sub="After cache-write overhead" icon={PiggyBank} accent="text-emerald-500" />
        <KpiCard title="Cache Write Tokens" value={fmtNum(s.cacheWriteTokens)} sub={`Uncached: ${fmtNum(s.uncachedInputTokens)}`} icon={DatabaseZap} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SvgMultiBarChart
          title="Prompt Tokens: Cache Hit vs Miss"
          description="Cached read hits stacked with uncached miss & cache write tokens"
          data={ts}
          xKey="bucket"
          mode="stacked"
          totalLabel="Total Prompt"
          series={[
            { key: "cachedReadTokens", label: "Cache Hit (Read)", color: "#0ea5e9" },
            { key: "uncachedInputTokens", label: "Cache Miss (Uncached)", color: "#64748b" },
            { key: "cacheWriteTokens", label: "Cache Write", color: "#8b5cf6" },
          ]}
          formatY={(v) => fmtNum(Math.round(v))}
          extraTooltip={(row) => `Hit Ratio: ${fmtPct(row.tokenCacheHitRatioPct)}`}
        />
        <SvgBarChart
          title="Cache Hit Ratio (%) Over Time"
          description="Share of prompt tokens served from cache per bucket"
          data={ts.map((r) => ({ bucketTs: r.bucketTs, bucket: r.bucket, value: r.tokenCacheHitRatioPct || 0 }))}
          xKey="bucket"
          valueKey="value"
          color="#0ea5e9"
          legendLabel="Hit Ratio %"
          formatY={(v) => `${Math.round(v)}%`}
        />
      </div>

      <Card>
        <CardHeader><CardTitle>Caching Performance by Model</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Prompt Tokens</TableHead>
                <TableHead className="text-right">Cached Read</TableHead>
                <TableHead className="text-right">Cache Write</TableHead>
                <TableHead className="text-right">Hit Ratio</TableHead>
                <TableHead className="text-right">Net Savings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No cache metrics recorded yet.</TableCell></TableRow>
              ) : (
                models.map((m) => (
                  <TableRow key={`${m.provider}/${m.model}`}>
                    <TableCell className="font-mono"><Badge variant="secondary" className="mr-2">{m.provider}</Badge>{m.model}</TableCell>
                    <TableCell className="text-right font-mono">{fmtNum(m.promptTokens)}</TableCell>
                    <TableCell className="text-right font-mono text-sky-500">{fmtNum(m.cachedReadTokens)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtNum(m.cacheWriteTokens)}</TableCell>
                    <TableCell className="text-right font-mono font-semibold text-sky-500">{fmtPct(m.tokenCacheHitRatioPct)}</TableCell>
                    <TableCell className="text-right font-mono text-emerald-500">{fmtUsd(m.netCacheSavingsUsd)}</TableCell>
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

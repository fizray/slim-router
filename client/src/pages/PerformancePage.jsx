import { useState, useEffect, useCallback } from "react";
import { Gauge, Zap, Clock, Timer, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fmtNum, fmtMs } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { KpiCard, RangeSelector, SvgMultiBarChart } from "@/components/charts";

export function PerformancePage() {
  const [range, setRange] = useState("24h");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiFetch(`/api/analytics/performance?range=${range}`));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const s = data?.summary || {};
  const ts = data?.timeseries || [];
  const models = data?.byModel || [];
  const latencySeries = ts.map((row) => {
    const total = Math.max(0, Number(row.avgLatencyMs || 0));
    const ttft = Math.min(total, Math.max(0, Number(row.avgTtftMs || 0)));
    return {
      ...row,
      avgTtftMs: ttft,
      avgGenMs: Math.max(0, total - ttft),
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Latency &amp; Throughput Performance</h2>
          <p className="text-xs text-muted-foreground">Log-linear histogram percentiles (p50/p95/p99) and streaming-only TPOT &amp; tokens/sec</p>
        </div>
        <div className="flex items-center gap-2">
          <RangeSelector value={range} onChange={setRange} />
          <Button variant="outline" size="icon" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard title="Latency P50 / P95" value={fmtMs(s.latencyP50Ms)} sub={`P95: ${fmtMs(s.latencyP95Ms)} · P99: ${fmtMs(s.latencyP99Ms)}`} icon={Clock} />
        <KpiCard title="TTFT P50 / P95" value={fmtMs(s.ttftP50Ms)} sub={`P95: ${fmtMs(s.ttftP95Ms)} (streaming)`} icon={Timer} />
        <KpiCard title="Avg Streaming TPS" value={s.avgOutputTps ? `${Number(s.avgOutputTps).toFixed(1)} tok/s` : "—"} sub="Non-streaming excluded" icon={Zap} accent="text-emerald-500" />
        <KpiCard title="Avg TPOT" value={fmtMs(s.avgTpotMs)} sub="Time per output token" icon={Gauge} />
      </div>

      <SvgMultiBarChart
        title="Latency Breakdown (TTFT + Generation)"
        description="Stacked Time-to-First-Token (TTFT) and generation duration per bucket"
        data={latencySeries}
        xKey="bucket"
        mode="stacked"
        totalLabel="Total Latency"
        series={[
          { key: "avgTtftMs", label: "TTFT", color: "#10b981", opacity: 0.9 },
          { key: "avgGenMs", label: "Generation", color: "#3b82f6", opacity: 0.82 },
        ]}
        formatY={(v) => fmtMs(v)}
      />

      <Card>
        <CardHeader>
          <CardTitle>Per-Model Performance Breakdown</CardTitle>
          <CardDescription>Streaming TPOT and TPS are strictly NULL for non-streaming calls to prevent skewed metrics.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y md:hidden">
            {models.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">No performance samples yet.</div>
            ) : (
              models.map((m) => (
                <div key={`${m.provider}/${m.model}`} className="px-4 py-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 font-mono text-xs font-medium truncate">
                      <Badge variant="secondary" className="mr-1.5">{m.provider}</Badge>
                      {m.model}
                    </div>
                    <span className="font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400 shrink-0">
                      {m.avgOutputTps ? `${Number(m.avgOutputTps).toFixed(1)} t/s` : "—"}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-[11px] font-mono text-muted-foreground">
                    <span>{fmtNum(m.requests)} calls</span>
                    <span>TTFT {fmtMs(m.ttftP50Ms)}</span>
                    <span>P50 {fmtMs(m.latencyP50Ms)}</span>
                    <span>P95 {fmtMs(m.latencyP95Ms)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">TTFT P50</TableHead>
                  <TableHead className="text-right">Latency P50</TableHead>
                  <TableHead className="text-right">Latency P95</TableHead>
                  <TableHead className="text-right">Avg TPS</TableHead>
                  <TableHead className="text-right">Avg TPOT</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No performance samples yet.</TableCell></TableRow>
                ) : (
                  models.map((m) => (
                    <TableRow key={`${m.provider}/${m.model}`}>
                      <TableCell className="font-mono whitespace-nowrap">
                        <Badge variant="secondary" className="mr-2">{m.provider}</Badge>
                        {m.model}
                      </TableCell>
                      <TableCell className="text-right font-mono">{fmtNum(m.requests)}</TableCell>
                      <TableCell className="text-right font-mono">{fmtMs(m.ttftP50Ms)}</TableCell>
                      <TableCell className="text-right font-mono">{fmtMs(m.latencyP50Ms)}</TableCell>
                      <TableCell className="text-right font-mono">{fmtMs(m.latencyP95Ms)}</TableCell>
                      <TableCell className="text-right font-mono text-emerald-600 dark:text-emerald-400">{m.avgOutputTps ? `${Number(m.avgOutputTps).toFixed(1)}` : "—"}</TableCell>
                      <TableCell className="text-right font-mono">{fmtMs(m.avgTpotMs)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

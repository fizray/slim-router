import { useState, useEffect, useCallback } from "react";
import { ShieldCheck, ShieldAlert, GitBranch, RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fmtNum, fmtPct } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { KpiCard, RangeSelector, SvgBarChart } from "@/components/charts";

export function ReliabilityPage() {
  const [range, setRange] = useState("24h");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiFetch(`/api/analytics/reliability?range=${range}`));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const s = data?.summary || {};
  const categories = (data?.errorCategories || []).map((c) => ({ label: c.category || "unknown", value: c.count || 0 }));
  const providers = data?.byProvider || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Reliability &amp; Failover Telemetry</h2>
          <p className="text-xs text-muted-foreground">Error taxonomy, rate limits (429), upstream health, and multi-key failover success</p>
        </div>
        <div className="flex items-center gap-2">
          <RangeSelector value={range} onChange={setRange} />
          <Button variant="outline" size="icon" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard title="Availability" value={fmtPct(s.successRatePct)} sub={`${fmtNum(s.totalRequests)} total calls`} icon={ShieldCheck} accent="text-emerald-500" />
        <KpiCard title="Total Errors" value={fmtNum(s.errorCount)} sub={`Error rate: ${fmtPct(s.errorRatePct)}`} icon={ShieldAlert} accent={s.errorCount > 0 ? "text-red-500" : ""} />
        <KpiCard title="Failovers Triggered" value={fmtNum(s.failoverCount)} sub="Multi-account / combo retries" icon={GitBranch} />
        <KpiCard title="Rate Limited (429)" value={fmtNum(s.rateLimitedCount)} sub="Upstream or key RPM/TPM" icon={ShieldAlert} />
      </div>

      <SvgBarChart
        title="Error Breakdown by Category"
        description="Distribution of failed requests by error class"
        data={categories}
        xKey="label"
        valueKey="value"
        color="#ef4444"
        height={185}
        legendLabel="Error Count"
        formatY={(v) => fmtNum(Math.round(v))}
      />

      <Card>
        <CardHeader><CardTitle>Provider Reliability</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Errors</TableHead>
                <TableHead className="text-right">Failovers</TableHead>
                <TableHead className="text-right">Success Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No provider reliability data yet.</TableCell></TableRow>
              ) : (
                providers.map((p) => (
                  <TableRow key={p.provider}>
                    <TableCell className="font-mono font-medium">{p.provider}</TableCell>
                    <TableCell className="text-right font-mono">{fmtNum(p.requests)}</TableCell>
                    <TableCell className="text-right font-mono text-red-500">{fmtNum(p.errors)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtNum(p.failovers)}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant={p.successRatePct >= 99 ? "success" : p.successRatePct >= 95 ? "warning" : "destructive"}>
                        {fmtPct(p.successRatePct)}
                      </Badge>
                    </TableCell>
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

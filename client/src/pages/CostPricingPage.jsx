import { useState, useEffect, useCallback } from "react";
import { DollarSign, TrendingUp, RefreshCw, Settings, Search, ChevronDown } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fmtNum, fmtUsd } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { KpiCard, RangeSelector, SvgMultiBarChart } from "@/components/charts";

export function CostPricingPage({ onNavigate }) {
  const [range, setRange] = useState("30d");
  const [costData, setCostData] = useState(null);
  const [pricingData, setPricingData] = useState(null);
  const [filter, setFilter] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [ratesOpen, setRatesOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, p] = await Promise.all([
        apiFetch(`/api/analytics/cost?range=${range}`),
        apiFetch("/api/pricing"),
      ]);
      setCostData(c);
      setPricingData(p);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { load().catch(() => {}); }, [load]);

  const s = costData?.summary || {};
  const byModel = costData?.byModel || [];
  const daily = (costData?.daily || []).map((d) => ({
    day: String(d.day || "").slice(5),
    costUsd: d.costUsd || 0,
    cacheSavingsUsd: Math.max(0, d.cacheSavingsUsd || 0),
  }));

  const pricingRows = [];
  for (const [provider, models] of Object.entries(pricingData?.pricing || {})) {
    if (providerFilter !== "all" && provider !== providerFilter) continue;
    for (const [model, rate] of Object.entries(models || {})) {
      if (filter && !`${provider}/${model}`.toLowerCase().includes(filter.toLowerCase())) continue;
      pricingRows.push({ provider, model, ...rate });
    }
  }
  pricingRows.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));

  const lastSync = pricingData?.meta?.syncedAt || pricingData?.syncState?.lastSync;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Cost Attribution &amp; Live Rates</h2>
          <p className="text-xs text-muted-foreground">Read-only spend analytics and active $/1M token rates synced from models.dev</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RangeSelector value={range} onChange={setRange} />
          <Button variant="outline" size="icon" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard title="Period Spend" value={fmtUsd(s.totalCostUsd)} sub={`${fmtNum(s.totalRequests)} requests`} icon={DollarSign} accent="text-emerald-500" />
        <KpiCard title="Cost Without Cache" value={fmtUsd(s.costWithoutCacheUsd)} sub={`Net saved: ${fmtUsd(s.netCacheSavingsUsd)}`} icon={TrendingUp} />
        <KpiCard title="Avg Cost / Request" value={fmtUsd(s.avgCostPerRequestUsd, 5)} sub="Effective blended cost" icon={DollarSign} />
        <KpiCard title="Active Rate Models" value={fmtNum(pricingRows.length)} sub={lastSync ? `Synced ${new Date(lastSync).toLocaleDateString()}` : "Sync in Settings"} icon={RefreshCw} />
      </div>

      <SvgMultiBarChart
        title="Daily Spend & Cache Savings (USD)"
        description="Actual daily cost stacked with USD saved by prompt caching"
        data={daily}
        xKey="day"
        mode="stacked"
        totalLabel="Without Cache"
        series={[
          { key: "costUsd", label: "Actual Spend", color: "#10b981" },
          { key: "cacheSavingsUsd", label: "Cache Saved", color: "#06b6d4" },
        ]}
        formatY={(v) => fmtUsd(v, 3)}
      />

      <Card>
        <CardHeader><CardTitle>Spend Breakdown by Model</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider / Model</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Cache Read</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byModel.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="py-6 text-center text-muted-foreground">No spend recorded yet.</TableCell></TableRow>
              ) : (
                byModel.map((m) => (
                  <TableRow key={`${m.provider}/${m.model}`}>
                    <TableCell className="font-mono"><Badge variant="secondary" className="mr-2">{m.provider}</Badge>{m.model}</TableCell>
                    <TableCell className="text-right font-mono">{fmtUsd(m.costInputUsd)}</TableCell>
                    <TableCell className="text-right font-mono text-sky-500">{fmtUsd(m.costCacheReadUsd)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtUsd(m.costOutputUsd)}</TableCell>
                    <TableCell className="text-right font-mono font-semibold">{fmtUsd(m.costTotalUsd)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Strictly Read-Only Live Rate Reference (Collapsible Dropdown — Default Collapsed) */}
      <Card>
        <CardHeader
          role="button"
          tabIndex={0}
          aria-expanded={ratesOpen}
          onClick={() => setRatesOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setRatesOpen((v) => !v);
            }
          }}
          className="cursor-pointer select-none flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between hover:bg-muted/30 transition-colors rounded-t-xl"
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <ChevronDown
              className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${ratesOpen ? "rotate-180" : "-rotate-90"}`}
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>Active Rate Table (Read-Only · $/1M tokens)</CardTitle>
                <Badge variant="secondary" className="font-mono text-[10px]">{fmtNum(pricingRows.length)} models</Badge>
              </div>
              <CardDescription className="mt-0.5">
                {lastSync ? `Last synced from models.dev: ${new Date(lastSync).toLocaleString()}` : "Rates not synced yet — trigger sync in Settings."}
                {!ratesOpen && " · Click to expand"}
              </CardDescription>
            </div>
          </div>
          {onNavigate && (
            <Button
              variant="outline"
              size="sm"
              className="self-start sm:self-auto"
              onClick={(e) => {
                e.stopPropagation();
                onNavigate("settings");
              }}
            >
              <Settings className="h-3.5 w-3.5" /> Edit Rates in Settings
            </Button>
          )}
        </CardHeader>
        {ratesOpen && (
          <CardContent className="space-y-3 border-t pt-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-3 sm:top-2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Filter model rate..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <NativeSelect className="sm:w-40" value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)}>
                <option value="all">All Providers</option>
                <option value="vertex">vertex</option>
                <option value="gemini">gemini</option>
                <option value="vertex-partner">vertex-partner</option>
              </NativeSelect>
            </div>

            {/* Mobile cards (< md) */}
            <div className="space-y-2 md:hidden">
              {pricingRows.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">No pricing rates loaded yet. Sync live rates in Settings.</div>
              ) : (
                pricingRows.slice(0, 60).map((r) => (
                  <div key={`${r.provider}/${r.model}`} className="rounded-lg border p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 font-mono text-xs font-medium truncate">
                        <Badge variant="secondary" className="mr-1.5">{r.provider}</Badge>
                        {r.model}
                      </div>
                      <Badge variant={r._source === "override" ? "warning" : "info"}>
                        {r._source === "override" ? "Override" : "Live"}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 text-[11px] font-mono text-muted-foreground">
                      <div>In: <span className="text-foreground">${Number(r.input || 0).toFixed(4)}</span></div>
                      <div>Out: <span className="text-foreground">${Number(r.output || 0).toFixed(4)}</span></div>
                      <div>Cache R: <span className="text-sky-500">${Number(r.cached ?? r.input ?? 0).toFixed(4)}</span></div>
                      <div>Cache W: <span className="text-foreground">${Number(r.cache_creation ?? r.input ?? 0).toFixed(4)}</span></div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Desktop table (>= md) */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider / Model</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Input</TableHead>
                    <TableHead className="text-right">Cached Read</TableHead>
                    <TableHead className="text-right">Cache Write</TableHead>
                    <TableHead className="text-right">Output</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pricingRows.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No pricing rates loaded yet. Sync live rates in Settings.</TableCell></TableRow>
                  ) : (
                    pricingRows.slice(0, 100).map((r) => (
                      <TableRow key={`${r.provider}/${r.model}`}>
                        <TableCell className="font-mono"><Badge variant="secondary" className="mr-2">{r.provider}</Badge>{r.model}</TableCell>
                        <TableCell>
                          <Badge variant={r._source === "override" ? "warning" : "info"}>
                            {r._source === "override" ? "Manual Override" : "models.dev Live"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono">${Number(r.input || 0).toFixed(4)}</TableCell>
                        <TableCell className="text-right font-mono text-sky-500">${Number(r.cached ?? r.input ?? 0).toFixed(4)}</TableCell>
                        <TableCell className="text-right font-mono">${Number(r.cache_creation ?? r.input ?? 0).toFixed(4)}</TableCell>
                        <TableCell className="text-right font-mono">${Number(r.output || 0).toFixed(4)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

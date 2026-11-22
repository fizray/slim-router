import { useState, useEffect, useCallback } from "react";
import { DollarSign, TrendingUp, RefreshCw, CloudDownload, Save, RotateCcw, Plus } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fmtNum, fmtUsd } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { KpiCard, RangeSelector, SvgBarChart } from "@/components/charts";

export function CostPricingPage() {
  const [range, setRange] = useState("30d");
  const [costData, setCostData] = useState(null);
  const [pricingData, setPricingData] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [filter, setFilter] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [customForm, setCustomForm] = useState({
    provider: "vertex",
    model: "",
    input: "",
    output: "",
    cached: "",
    cache_creation: "",
  });

  const load = useCallback(async () => {
    const [c, p] = await Promise.all([
      apiFetch(`/api/analytics/cost?range=${range}`),
      apiFetch("/api/pricing"),
    ]);
    setCostData(c);
    setPricingData(p);
  }, [range]);

  useEffect(() => { load().catch(() => {}); }, [load]);

  async function handleSyncNow() {
    setSyncing(true); setMsg(""); setErr("");
    try {
      const res = await apiFetch("/api/pricing", { method: "POST" });
      setPricingData(res);
      const total = res?.syncResult?.totalModels ?? 0;
      setMsg(`Synced live pricing from models.dev (${total} Vertex/Gemini models updated).`);
    } catch (e) {
      setErr(e.message || "Failed to sync live pricing");
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveOverride(e) {
    e.preventDefault();
    setMsg(""); setErr("");
    if (!customForm.model.trim()) return setErr("Model ID is required");
    const rate = {
      input: Number(customForm.input || 0),
      output: Number(customForm.output || 0),
      cached: Number(customForm.cached || customForm.input || 0),
      cache_creation: Number(customForm.cache_creation || customForm.input || 0),
    };
    try {
      const res = await apiFetch("/api/pricing", {
        method: "PATCH",
        body: { [customForm.provider]: { [customForm.model.trim()]: rate } },
      });
      setPricingData(res);
      setCustomForm((f) => ({ ...f, model: "", input: "", output: "", cached: "", cache_creation: "" }));
      setMsg(`Saved manual pricing override for ${customForm.provider}/${customForm.model.trim()}.`);
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function handleResetOverride(provider, model) {
    setMsg(""); setErr("");
    try {
      const res = await apiFetch(`/api/pricing?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`, {
        method: "DELETE",
      });
      setPricingData(res);
      setMsg(`Reset override for ${provider}/${model} back to live synced rate.`);
    } catch (e) {
      setErr(e.message);
    }
  }

  const s = costData?.summary || {};
  const byModel = costData?.byModel || [];
  const daily = (costData?.daily || []).map((d) => ({ label: String(d.day || "").slice(5), value: d.costUsd || 0 }));

  const pricingRows = [];
  for (const [provider, models] of Object.entries(pricingData?.pricing || {})) {
    for (const [model, rate] of Object.entries(models || {})) {
      if (filter && !`${provider}/${model}`.toLowerCase().includes(filter.toLowerCase())) continue;
      pricingRows.push({ provider, model, ...rate });
    }
  }
  pricingRows.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));

  const lastSync = pricingData?.meta?.syncedAt || pricingData?.syncState?.lastSync;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Cost Attribution &amp; Dynamic Live Pricing</h2>
          <p className="text-xs text-muted-foreground">Zero hardcoded prices — synced dynamically from models.dev/api.json with per-model DB overrides</p>
        </div>
        <div className="flex items-center gap-2">
          <RangeSelector value={range} onChange={setRange} />
          <Button variant="default" size="sm" onClick={handleSyncNow} disabled={syncing}>
            <CloudDownload className={`h-3.5 w-3.5 ${syncing ? "animate-bounce" : ""}`} />
            {syncing ? "Syncing..." : "Sync Live Pricing"}
          </Button>
        </div>
      </div>

      {msg && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">{msg}</div>}
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard title="Period Spend" value={fmtUsd(s.totalCostUsd)} sub={`${fmtNum(s.totalRequests)} requests`} icon={DollarSign} accent="text-emerald-500" />
        <KpiCard title="Cost Without Cache" value={fmtUsd(s.costWithoutCacheUsd)} sub={`Net saved: ${fmtUsd(s.netCacheSavingsUsd)}`} icon={TrendingUp} />
        <KpiCard title="Avg Cost / Request" value={fmtUsd(s.avgCostPerRequestUsd, 5)} sub="Effective blended cost" icon={DollarSign} />
        <KpiCard title="Live Pricing Models" value={fmtNum(pricingRows.length)} sub={lastSync ? `Synced ${new Date(lastSync).toLocaleString()}` : "Not synced yet — click Sync"} icon={RefreshCw} />
      </div>

      <SvgBarChart title="Daily Spend (USD)" data={daily} xKey="label" valueKey="value" color="#10b981" formatY={(v) => fmtUsd(v, 3)} />

      <Card>
        <CardHeader>
          <CardTitle>Spend Breakdown by Model</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider / Model</TableHead>
                <TableHead className="text-right">Input Cost</TableHead>
                <TableHead className="text-right">Cache Read</TableHead>
                <TableHead className="text-right">Cache Write</TableHead>
                <TableHead className="text-right">Output Cost</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byModel.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">No spend recorded yet.</TableCell></TableRow>
              ) : (
                byModel.map((m) => (
                  <TableRow key={`${m.provider}/${m.model}`}>
                    <TableCell className="font-mono"><Badge variant="secondary" className="mr-2">{m.provider}</Badge>{m.model}</TableCell>
                    <TableCell className="text-right font-mono">{fmtUsd(m.costInputUsd)}</TableCell>
                    <TableCell className="text-right font-mono text-sky-500">{fmtUsd(m.costCacheReadUsd)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtUsd(m.costCacheWriteUsd)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtUsd(m.costOutputUsd)}</TableCell>
                    <TableCell className="text-right font-mono font-semibold">{fmtUsd(m.costTotalUsd)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Live Rate Table ($ / 1M tokens)</CardTitle>
              <CardDescription>Auto-synced from models.dev into config.sqlite; add manual overrides below for custom or preview models.</CardDescription>
            </div>
            <Input
              className="w-56"
              placeholder="Filter model..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleSaveOverride} className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-3 md:grid-cols-7">
            <NativeSelect value={customForm.provider} onChange={(e) => setCustomForm((f) => ({ ...f, provider: e.target.value }))}>
              <option value="vertex">vertex</option>
              <option value="gemini">gemini</option>
              <option value="vertex-partner">vertex-partner</option>
            </NativeSelect>
            <Input placeholder="model id (e.g. gemini-2.5-pro)" value={customForm.model} onChange={(e) => setCustomForm((f) => ({ ...f, model: e.target.value }))} />
            <Input type="number" step="any" placeholder="Input $/1M" value={customForm.input} onChange={(e) => setCustomForm((f) => ({ ...f, input: e.target.value }))} />
            <Input type="number" step="any" placeholder="Output $/1M" value={customForm.output} onChange={(e) => setCustomForm((f) => ({ ...f, output: e.target.value }))} />
            <Input type="number" step="any" placeholder="Cache Read $/1M" value={customForm.cached} onChange={(e) => setCustomForm((f) => ({ ...f, cached: e.target.value }))} />
            <Input type="number" step="any" placeholder="Cache Write $/1M" value={customForm.cache_creation} onChange={(e) => setCustomForm((f) => ({ ...f, cache_creation: e.target.value }))} />
            <Button type="submit" size="default">
              <Plus className="h-3.5 w-3.5" />
              Save Override
            </Button>
          </form>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider / Model</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Cached Read</TableHead>
                <TableHead className="text-right">Cache Write</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pricingRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    No pricing rates loaded yet. Click <strong>Sync Live Pricing</strong> above to pull official rates from models.dev.
                  </TableCell>
                </TableRow>
              ) : (
                pricingRows.slice(0, 80).map((r) => (
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
                    <TableCell className="text-right">
                      {r._source === "override" ? (
                        <Button variant="ghost" size="sm" onClick={() => handleResetOverride(r.provider, r.model)}>
                          <RotateCcw className="h-3 w-3" /> Reset
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setCustomForm({
                            provider: r.provider,
                            model: r.model,
                            input: String(r.input ?? ""),
                            output: String(r.output ?? ""),
                            cached: String(r.cached ?? ""),
                            cache_creation: String(r.cache_creation ?? ""),
                          })}
                        >
                          <Save className="h-3 w-3" /> Override
                        </Button>
                      )}
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

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Search, X, FileImage, Copy, Check } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fmtMs, fmtNum, fmtUsd, fmtBytes, fmtPct } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

function getCacheStats(t) {
  const prompt = Number(t?.prompt_tokens || 0);
  const hit = Number(t?.cached_read_tokens || 0);
  const write = Number(t?.cache_write_tokens || 0);
  const miss = t?.uncached_input_tokens != null
    ? Number(t.uncached_input_tokens)
    : Math.max(0, prompt - hit);
  const isHit = hit > 0;
  const hitPct = prompt > 0 ? (hit / prompt) * 100 : 0;
  return { prompt, hit, miss, write, isHit, hitPct };
}

function CacheCell({ trace, showMissDetail = false }) {
  const c = getCacheStats(trace);
  const tooltip = `Prompt: ${c.prompt.toLocaleString()} | Hit: ${c.hit.toLocaleString()} (${c.hitPct.toFixed(1)}%) | Miss: ${c.miss.toLocaleString()}${c.write > 0 ? ` | Write: ${c.write.toLocaleString()}` : ""}${trace?.cache_net_savings ? ` | Saved: ${fmtUsd(trace.cache_net_savings)}` : ""}`;
  return (
    <div className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap" title={tooltip}>
      <Badge variant={c.isHit ? "info" : "secondary"} className="px-1.5 py-0 text-[10px] font-semibold">
        {c.isHit ? "HIT" : "MISS"}
      </Badge>
      <span className={`font-mono text-[11px] ${c.isHit ? "text-sky-600 dark:text-sky-400 font-medium" : "text-muted-foreground"}`}>
        {c.isHit ? `${fmtNum(c.hit)} (${Math.round(c.hitPct)}%)` : `${fmtNum(c.miss)} miss`}
      </span>
      {showMissDetail && c.isHit && c.miss > 0 && (
        <span className="font-mono text-[10.5px] text-muted-foreground">· {fmtNum(c.miss)} miss</span>
      )}
    </div>
  );
}

function fmtTps(tps) {
  if (tps == null || !Number.isFinite(Number(tps)) || Number(tps) <= 0) return "—";
  return `${Number(tps).toFixed(1)} t/s`;
}

function TraceDetailContent({ selected, detailLoading }) {
  if (detailLoading) {
    return <div className="py-8 text-center text-xs text-muted-foreground">Loading trace detail...</div>;
  }
  const t = selected.trace || {};
  const c = getCacheStats(t);
  const decodeMs = t.ttft_ms != null && t.total_ms != null ? Math.max(0, Number(t.total_ms) - Number(t.ttft_ms)) : null;
  const costTooltip = `Input: ${fmtUsd(t.cost_input || 0, 5)} | Cache Read: ${fmtUsd(t.cost_cache_read || 0, 5)}${t.cost_cache_write ? ` | Cache Write: ${fmtUsd(t.cost_cache_write, 5)}` : ""} | Output: ${fmtUsd(t.cost_output || 0, 5)}`;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="rounded-md border p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Latency</div>
          <div className="mt-1 font-mono text-xs font-semibold">{fmtMs(t.total_ms)}</div>
          <div className="text-[10px] font-mono text-muted-foreground truncate">
            {t.is_stream ? "Stream" : "Non-stream"}{t.attempt_count > 1 ? ` · ${t.attempt_count}x` : ""}
          </div>
        </div>
        <div className="rounded-md border p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">TTFT</div>
          <div className="mt-1 font-mono text-xs font-semibold">{t.ttft_ms != null ? fmtMs(t.ttft_ms) : "—"}</div>
          <div className="text-[10px] font-mono text-muted-foreground truncate">
            {decodeMs != null ? `Gen ${fmtMs(decodeMs)}` : "No stream TTFT"}
          </div>
        </div>
        <div className="rounded-md border p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Speed (TPS)</div>
          <div className="mt-1 font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400">{fmtTps(t.output_tps)}</div>
          <div className="text-[10px] font-mono text-muted-foreground truncate">
            {t.tpot_ms != null ? `TPOT ${fmtMs(t.tpot_ms)}` : "Short / non-stream"}
          </div>
        </div>
        <div className="rounded-md border p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Output</div>
          <div className="mt-1 font-mono text-xs font-semibold">{fmtNum(t.completion_tokens || 0)}</div>
          <div className="text-[10px] font-mono text-muted-foreground truncate">
            {t.reasoning_tokens > 0 ? `Reason ${fmtNum(t.reasoning_tokens)}` : `Prompt ${fmtNum(c.prompt)}`}
          </div>
        </div>

        <div className="rounded-md border p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Cache Status</div>
          <div className="mt-1 flex items-center gap-1.5">
            <Badge variant={c.isHit ? "info" : "secondary"}>{c.isHit ? "HIT" : "MISS"}</Badge>
            <span className="font-mono text-xs font-semibold text-sky-600 dark:text-sky-400">{fmtPct(c.hitPct)}</span>
          </div>
        </div>
        <div className="rounded-md border p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Hit / Miss</div>
          <div className="mt-1 font-mono text-xs font-semibold text-sky-600 dark:text-sky-400">{fmtNum(c.hit)}</div>
          <div className="text-[10px] font-mono text-muted-foreground truncate">
            Miss {fmtNum(c.miss)}{c.write > 0 ? ` · W ${fmtNum(c.write)}` : ""}
          </div>
        </div>
        <div className="rounded-md border p-2" title={costTooltip}>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Price</div>
          <div className="mt-1 font-mono text-xs font-semibold">{fmtUsd(t.cost_total || 0)}</div>
          <div className="text-[10px] font-mono text-muted-foreground truncate">
            Full {fmtUsd(t.cost_without_cache || 0)}
          </div>
        </div>
        <div className="rounded-md border p-2" title={costTooltip}>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Cache Saved</div>
          <div className="mt-1 font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-400">{fmtUsd(t.cache_net_savings || 0)}</div>
          <div className="text-[10px] font-mono text-muted-foreground truncate">
            Out {fmtUsd(t.cost_output || 0, 4)}
          </div>
        </div>
      </div>
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Span Waterfall</div>
        <div className="space-y-1.5">
          {(selected.spans || []).map((sp, i) => {
            const totalMs = Math.max(1, selected.trace?.total_ms || 1);
            const leftPct = Math.min(95, ((sp.started_at_ms || 0) / totalMs) * 100);
            const widthPct = Math.max(3, Math.min(100 - leftPct, ((sp.duration_ms || 1) / totalMs) * 100));
            return (
              <div key={i} className="rounded-md border p-2 text-[11px]">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="font-mono font-medium truncate">{sp.span_type} {sp.provider ? `(${sp.provider})` : ""}</span>
                  <span className="font-mono text-muted-foreground shrink-0">{fmtMs(sp.duration_ms)} · {sp.http_status || sp.status}</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden relative">
                  <div
                    className={`absolute top-0 bottom-0 rounded-full ${sp.status === "error" ? "bg-red-500" : "bg-sky-500"}`}
                    style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {selected.payload?.mediaManifest?.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Multimodal Media Manifest</div>
          <div className="space-y-1">
            {selected.payload.mediaManifest.map((m, i) => (
              <div key={i} className="flex items-center justify-between rounded-md border px-2.5 py-1.5 text-[11px] font-mono">
                <span className="inline-flex items-center gap-1.5">
                  <FileImage className="h-3.5 w-3.5 text-sky-500" />
                  {m.mimeType}
                </span>
                <span className="text-muted-foreground">{fmtBytes(m.bytes)} · {String(m.sha256 || "").slice(0, 10)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {selected.payload && (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Sanitized Payload (Gzip BLOB)</div>
          <pre className="max-h-72 overflow-auto rounded-md border bg-muted/40 p-2.5 text-[10.5px] font-mono whitespace-pre-wrap break-all">
            {JSON.stringify({
              clientRequest: selected.payload.clientRequest,
              clientResponse: selected.payload.clientResponse,
            }, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function TracesPage() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ status: "", provider: "", cache: "", search: "" });
  const [selected, setSelected] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [copiedTrace, setCopiedTrace] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: "50" });
      if (filters.status) qs.set("status", filters.status);
      if (filters.provider) qs.set("provider", filters.provider);
      if (filters.cache) qs.set("cache", filters.cache);
      if (filters.search) qs.set("search", filters.search);
      const data = await apiFetch(`/api/analytics/traces?${qs}`);
      setItems(data.items || []);
      setTotal(data.total || 0);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  async function openTrace(traceId) {
    setDetailLoading(true);
    try {
      setSelected(await apiFetch(`/api/analytics/traces/${encodeURIComponent(traceId)}`));
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Request Trace Explorer</h2>
          <p className="text-xs text-muted-foreground">Forever-retained traces ({fmtNum(total)} total) with span waterfalls &amp; redacted payloads</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="p-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-3 sm:top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search trace ID, model, endpoint..."
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-3 gap-2 sm:flex">
            <NativeSelect className="sm:w-36" value={filters.provider} onChange={(e) => setFilters((f) => ({ ...f, provider: e.target.value }))}>
              <option value="">Provider</option>
              <option value="vertex">vertex</option>
              <option value="gemini">gemini</option>
              <option value="vertex-partner">vertex-partner</option>
            </NativeSelect>
            <NativeSelect className="sm:w-32" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
              <option value="">Status</option>
              <option value="success">Success</option>
              <option value="error">Error</option>
            </NativeSelect>
            <NativeSelect className="sm:w-32" value={filters.cache} onChange={(e) => setFilters((f) => ({ ...f, cache: e.target.value }))}>
              <option value="">Cache</option>
              <option value="hit">Cache Hit</option>
              <option value="miss">Cache Miss</option>
            </NativeSelect>
          </div>
        </CardContent>
      </Card>

      {/* Mobile card list (< md) */}
      <div className="space-y-2 md:hidden">
        {items.length === 0 ? (
          <Card><CardContent className="py-10 text-center text-xs text-muted-foreground">No traces match your filter.</CardContent></Card>
        ) : (
          items.map((t) => (
            <Card key={t.trace_id} className="cursor-pointer active:scale-[0.99] transition-transform" onClick={() => openTrace(t.trace_id)}>
              <CardContent className="p-3.5 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge variant={t.status === "success" ? "success" : "destructive"}>{t.http_status || t.status}</Badge>
                    <span className="font-mono text-xs font-medium truncate">{t.final_provider}/{t.final_model || t.requested_model}</span>
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground shrink-0">{new Date(t.epoch_ms).toLocaleTimeString()}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                  <CacheCell trace={t} showMissDetail />
                  <span className="font-semibold shrink-0">{fmtUsd(t.cost_total)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] font-mono text-muted-foreground">
                  <span>{fmtMs(t.total_ms)}{t.ttft_ms != null ? ` (TTFT ${fmtMs(t.ttft_ms)})` : ""}</span>
                  {t.output_tps != null && (
                    <span className="text-emerald-600 dark:text-emerald-400 font-medium">{fmtTps(t.output_tps)}</span>
                  )}
                  <span>out {fmtNum(t.completion_tokens || 0)}</span>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <div className="hidden md:grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card className={selected ? "xl:col-span-7" : "xl:col-span-12"}>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Model</TableHead>
                  {!selected && <TableHead className="text-right">Latency / TTFT</TableHead>}
                  {!selected && <TableHead className="text-right">TPS</TableHead>}
                  {!selected && <TableHead className="text-right">Out</TableHead>}
                  <TableHead className="text-right">Cache (Hit / Miss)</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow><TableCell colSpan={selected ? 5 : 8} className="py-10 text-center text-muted-foreground">No traces match your filter.</TableCell></TableRow>
                ) : (
                  items.map((t) => (
                    <TableRow
                      key={t.trace_id}
                      className="cursor-pointer"
                      data-state={selected?.trace?.trace_id === t.trace_id ? "selected" : undefined}
                      onClick={() => openTrace(t.trace_id)}
                    >
                      <TableCell className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {new Date(t.epoch_ms).toLocaleTimeString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant={t.status === "success" ? "success" : "destructive"}>
                          {t.http_status || t.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-[11px] whitespace-nowrap" title={t.endpoint || ""}>
                        <span className="text-muted-foreground">{t.final_provider}/</span>{t.final_model || t.requested_model}
                      </TableCell>
                      {!selected && (
                        <TableCell
                          className="text-right font-mono text-[11px] whitespace-nowrap"
                          title={`Total: ${fmtMs(t.total_ms)}${t.ttft_ms != null ? ` · TTFT: ${fmtMs(t.ttft_ms)}` : ""}${t.tpot_ms != null ? ` · TPOT: ${fmtMs(t.tpot_ms)}` : ""}`}
                        >
                          <span>{fmtMs(t.total_ms)}</span>
                          {t.ttft_ms != null && (
                            <span className="text-muted-foreground"> / {fmtMs(t.ttft_ms)}</span>
                          )}
                        </TableCell>
                      )}
                      {!selected && (
                        <TableCell className="text-right font-mono text-[11px] whitespace-nowrap">
                          <span className={t.output_tps != null ? "text-emerald-600 dark:text-emerald-400 font-medium" : "text-muted-foreground"}>
                            {fmtTps(t.output_tps)}
                          </span>
                        </TableCell>
                      )}
                      {!selected && (
                        <TableCell
                          className="text-right font-mono text-[11px] whitespace-nowrap"
                          title={`Output: ${Number(t.completion_tokens || 0).toLocaleString()}${t.reasoning_tokens > 0 ? ` (Reasoning: ${Number(t.reasoning_tokens).toLocaleString()})` : ""} | Prompt: ${Number(t.prompt_tokens || 0).toLocaleString()}`}
                        >
                          {fmtNum(t.completion_tokens || 0)}
                        </TableCell>
                      )}
                      <TableCell className="text-right"><CacheCell trace={t} showMissDetail={!selected} /></TableCell>
                      <TableCell
                        className="text-right font-mono whitespace-nowrap"
                        title={`Total: ${fmtUsd(t.cost_total || 0, 5)} | No-cache: ${fmtUsd(t.cost_without_cache || 0, 5)} | Saved: ${fmtUsd(t.cache_net_savings || 0, 5)}`}
                      >
                        {fmtUsd(t.cost_total)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {selected && (
          <Card className="hidden xl:block xl:col-span-5">
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <CardTitle className="font-mono text-xs truncate">{selected.trace?.trace_id}</CardTitle>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(selected.trace?.trace_id || "");
                      setCopiedTrace(true);
                      setTimeout(() => setCopiedTrace(false), 1400);
                    }}
                    className="text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
                    title="Copy trace ID"
                  >
                    {copiedTrace ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                  </button>
                </div>
                <CardDescription>
                  {selected.trace?.final_provider}/{selected.trace?.final_model} · {selected.trace?.endpoint} · {fmtMs(selected.trace?.total_ms)}
                </CardDescription>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setSelected(null)}>
                <X className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent>
              <TraceDetailContent selected={selected} detailLoading={detailLoading} />
            </CardContent>
          </Card>
        )}
      </div>

      {/* Full-screen Slide-Over Detail Sheet for Mobile & Tablet (< xl) */}
      {selected && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background xl:hidden">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <div className="min-w-0">
              <div className="font-mono text-xs font-semibold truncate">{selected.trace?.trace_id}</div>
              <div className="text-[11px] text-muted-foreground truncate">
                {selected.trace?.final_provider}/{selected.trace?.final_model} · {fmtMs(selected.trace?.total_ms)} · {fmtUsd(selected.trace?.cost_total)}
              </div>
            </div>
            <Button variant="outline" size="icon" onClick={() => setSelected(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 pb-8">
            <TraceDetailContent selected={selected} detailLoading={detailLoading} />
          </div>
        </div>
      )}
    </div>
  );
}

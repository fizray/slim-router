import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Search, X, FileImage } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fmtMs, fmtNum, fmtUsd, fmtBytes } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, NativeSelect } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export function TracesPage() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ status: "", provider: "", search: "" });
  const [selected, setSelected] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: "50" });
      if (filters.status) qs.set("status", filters.status);
      if (filters.provider) qs.set("provider", filters.provider);
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Request Trace Explorer</h2>
          <p className="text-xs text-muted-foreground">Forever-retained traces ({fmtNum(total)} total) with span waterfalls, media manifests, and redacted payloads</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <Card>
        <CardContent className="p-3 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search trace ID, model, endpoint..."
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            />
          </div>
          <NativeSelect className="w-36" value={filters.provider} onChange={(e) => setFilters((f) => ({ ...f, provider: e.target.value }))}>
            <option value="">All Providers</option>
            <option value="vertex">vertex</option>
            <option value="gemini">gemini</option>
            <option value="vertex-partner">vertex-partner</option>
          </NativeSelect>
          <NativeSelect className="w-32" value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
            <option value="">All Status</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
          </NativeSelect>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <Card className={selected ? "xl:col-span-7" : "xl:col-span-12"}>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No traces match your filter.</TableCell></TableRow>
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
                      <TableCell className="font-mono text-[11px]">
                        <span className="text-muted-foreground">{t.final_provider}/</span>{t.final_model || t.requested_model}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">{t.endpoint}</TableCell>
                      <TableCell className="text-right font-mono">{fmtMs(t.total_ms)}</TableCell>
                      <TableCell className="text-right font-mono">{fmtNum((t.prompt_tokens || 0) + (t.completion_tokens || 0))}</TableCell>
                      <TableCell className="text-right font-mono">{fmtUsd(t.cost_total)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {selected && (
          <Card className="xl:col-span-5">
            <CardHeader className="flex flex-row items-start justify-between gap-2">
              <div className="min-w-0">
                <CardTitle className="font-mono text-xs truncate">{selected.trace?.trace_id}</CardTitle>
                <CardDescription>
                  {selected.trace?.final_provider}/{selected.trace?.final_model} · {fmtMs(selected.trace?.total_ms)} · {fmtUsd(selected.trace?.cost_total)}
                </CardDescription>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setSelected(null)}>
                <X className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {detailLoading ? (
                <div className="py-8 text-center text-xs text-muted-foreground">Loading trace detail...</div>
              ) : (
                <>
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
                              <span className="font-mono font-medium">{sp.span_type} {sp.provider ? `(${sp.provider})` : ""}</span>
                              <span className="font-mono text-muted-foreground">{fmtMs(sp.duration_ms)} · {sp.http_status || sp.status}</span>
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
                      <pre className="max-h-60 overflow-auto rounded-md border bg-muted/50 p-2.5 text-[10px] font-mono">
                        {JSON.stringify({
                          clientRequest: selected.payload.clientRequest,
                          clientResponse: selected.payload.clientResponse,
                        }, null, 2)}
                      </pre>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

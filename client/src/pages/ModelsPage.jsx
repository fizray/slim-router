import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Play, RefreshCw, Search, CheckCircle2, XCircle, Loader2, KeyRound,
  Plus, Copy, Check, Power, Sparkles, ChevronDown, ChevronUp, Trash2, CloudDownload,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fmtMs } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea, Label, NativeSelect } from "@/components/ui/input";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { KpiCard } from "@/components/charts";

export function ModelsPage() {
  const [models, setModels] = useState([]);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [probeMap, setProbeMap] = useState({});
  const [batchRunning, setBatchRunning] = useState(false);
  const [syncingCatalog, setSyncingCatalog] = useState(false);
  const [copiedId, setCopiedId] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  // Interactive API Key & Prompt Tester
  const [testerOpen, setTesterOpen] = useState(true);
  const [testerTab, setTesterTab] = useState("provider"); // "provider" | "gateway"
  const [testerRunning, setTesterRunning] = useState(false);
  const [testerResult, setTesterResult] = useState(null);
  const [probeForm, setProbeForm] = useState({
    provider: "vertex",
    model: "gemini-2.5-flash",
    connectionId: "",
    apiKey: "",
    projectId: "",
    location: "us-central1",
    prompt: "Reply with OK and your model name.",
    gatewayApiKey: "",
    runUpstream: true,
  });

  // Add Custom Model inline drawer
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customForm, setCustomForm] = useState({ providerAlias: "vertex", id: "", name: "", type: "llm" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, cRes] = await Promise.all([
        apiFetch("/api/models"),
        apiFetch("/api/providers"),
      ]);
      setModels(mRes.models || []);
      setConnections(cRes.connections || []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return models.filter((m) => {
      if (providerFilter !== "all" && m.provider !== providerFilter) return false;
      if (kindFilter !== "all" && m.kind !== kindFilter) return false;
      if (q && !`${m.provider}/${m.model} ${m.name}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [models, providerFilter, kindFilter, search]);

  async function probeSingle(m) {
    const key = `${m.provider}/${m.model}/${m.kind}`;
    setProbeMap((prev) => ({ ...prev, [key]: { running: true } }));
    try {
      const res = await apiFetch("/api/models/probe", {
        method: "POST",
        body: { provider: m.provider, model: m.model, kind: m.kind },
      });
      setProbeMap((prev) => ({ ...prev, [key]: { ...res, running: false } }));
      return res;
    } catch (e) {
      const fail = { ok: false, error: e.message, running: false };
      setProbeMap((prev) => ({ ...prev, [key]: fail }));
      return fail;
    }
  }

  async function handleBatchProbe() {
    const targets = filtered.filter((m) => !m.disabled && m.hasActiveConnection && (m.kind === "llm" || m.kind === "embedding"));
    if (targets.length === 0) {
      setErr("No active LLM/embedding models with a configured connection in current filter.");
      return;
    }
    setErr("");
    setMsg(`Probing ${targets.length} model(s)...`);
    setBatchRunning(true);
    let okCount = 0;
    try {
      for (const m of targets) {
        const res = await probeSingle(m);
        if (res?.ok) okCount++;
      }
      setMsg(`Batch probe finished: ${okCount}/${targets.length} healthy.`);
    } finally {
      setBatchRunning(false);
    }
  }

  async function handleRunTester(e) {
    e.preventDefault();
    setTesterRunning(true);
    setTesterResult(null);
    try {
      const payload = testerTab === "gateway"
        ? {
            gatewayApiKey: probeForm.gatewayApiKey,
            provider: probeForm.provider,
            model: probeForm.model,
            prompt: probeForm.prompt,
            runUpstream: probeForm.runUpstream,
          }
        : {
            provider: probeForm.provider,
            model: probeForm.model,
            connectionId: probeForm.connectionId || undefined,
            apiKey: probeForm.apiKey || undefined,
            projectId: probeForm.projectId || undefined,
            location: probeForm.location || undefined,
            prompt: probeForm.prompt,
          };
      const res = await apiFetch("/api/models/probe", { method: "POST", body: payload });
      setTesterResult(res);
    } catch (e2) {
      setTesterResult({ ok: false, error: e2.message });
    } finally {
      setTesterRunning(false);
    }
  }

  async function handleToggleDisabled(m) {
    setErr(""); setMsg("");
    try {
      if (m.disabled) {
        await apiFetch(`/api/models/disabled?providerAlias=${encodeURIComponent(m.provider)}&id=${encodeURIComponent(m.model)}`, {
          method: "DELETE",
        });
      } else {
        await apiFetch("/api/models/disabled", {
          method: "POST",
          body: { providerAlias: m.provider, ids: [m.model] },
        });
      }
      load();
    } catch (e) {
      setErr(e.message);
    }
  }

  async function handleAddCustom(e) {
    e.preventDefault();
    if (!customForm.id.trim()) return;
    setErr(""); setMsg("");
    try {
      await apiFetch("/api/models/custom", {
        method: "POST",
        body: {
          providerAlias: customForm.providerAlias,
          id: customForm.id.trim(),
          name: customForm.name.trim() || customForm.id.trim(),
          type: customForm.type,
        },
      });
      setCustomForm({ providerAlias: "vertex", id: "", name: "", type: "llm" });
      setShowCustomForm(false);
      setMsg("Custom model added.");
      load();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function handleDeleteCustom(m) {
    await apiFetch(`/api/models/custom?providerAlias=${encodeURIComponent(m.providerAlias)}&id=${encodeURIComponent(m.model)}&type=${encodeURIComponent(m.kind)}`, {
      method: "DELETE",
    });
    load();
  }

  async function handleSyncCatalog() {
    setSyncingCatalog(true); setErr(""); setMsg("");
    try {
      const res = await apiFetch("/api/pricing", { method: "POST" });
      await load();
      const c = res?.syncResult?.counts;
      setMsg(c
        ? `Catalog synced from models.dev: ${c.vertex} Vertex, ${c.gemini} AI Studio, ${c["vertex-partner"]} Partner models.`
        : "Catalog synced from models.dev.");
    } catch (e) {
      setErr(e.message || "Catalog sync failed");
    } finally {
      setSyncingCatalog(false);
    }
  }

  function copyModelId(id) {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(""), 1400);
  }

  const probeVals = Object.values(probeMap).filter((x) => !x.running);
  const okProbes = probeVals.filter((x) => x.ok).length;
  const failProbes = probeVals.filter((x) => !x.ok).length;
  const matchingConns = connections.filter((c) => c.provider === probeForm.provider);
  const providerModelOptions = models.filter((m) => m.provider === probeForm.provider && m.kind === "llm");

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Models &amp; Live Probe</h2>
          <p className="text-xs text-muted-foreground">Browse all Vertex AI &amp; AI Studio models, probe live latency, and test provider or gateway API keys</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleSyncCatalog} disabled={syncingCatalog}>
            <CloudDownload className={`h-3.5 w-3.5 ${syncingCatalog ? "animate-bounce" : ""}`} />
            {syncingCatalog ? "Syncing..." : "Sync Catalog"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowCustomForm((v) => !v)}>
            <Plus className="h-3.5 w-3.5" /> Custom
          </Button>
          <Button variant="default" size="sm" onClick={handleBatchProbe} disabled={batchRunning || loading}>
            {batchRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Probe Active
          </Button>
          <Button variant="outline" size="icon" onClick={load} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {msg && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">{msg}</div>}
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard title="Catalog Models" value={models.length} sub={`${models.filter((m) => !m.disabled).length} enabled`} icon={Sparkles} />
        <KpiCard title="Active Connections" value={connections.filter((c) => c.isActive).length} sub={`${connections.length} total configured`} icon={KeyRound} />
        <KpiCard title="Probed Healthy" value={okProbes} sub="Verified live response" icon={CheckCircle2} accent="text-emerald-500" />
        <KpiCard title="Probed Failed" value={failProbes} sub="Auth, quota, or model error" icon={XCircle} accent={failProbes > 0 ? "text-red-500" : ""} />
      </div>

      {/* Collapsible Interactive API Key & Prompt Tester */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-sky-500 shrink-0" />
              API Key &amp; Live Prompt Tester
            </CardTitle>
            <CardDescription className="mt-0.5">Test saved connections, ad-hoc AI Studio/Vertex credentials, or client sk-9r_ gateway keys</CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setTesterOpen((o) => !o)}>
            {testerOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </CardHeader>

        {testerOpen && (
          <CardContent className="space-y-4">
            <TabsList>
              <TabsTrigger active={testerTab === "provider"} onClick={() => { setTesterTab("provider"); setTesterResult(null); }}>
                Provider / Ad-hoc Key
              </TabsTrigger>
              <TabsTrigger active={testerTab === "gateway"} onClick={() => { setTesterTab("gateway"); setTesterResult(null); }}>
                Gateway Key (sk-9r_)
              </TabsTrigger>
            </TabsList>

            <form onSubmit={handleRunTester} className="space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>Provider</Label>
                  <NativeSelect
                    value={probeForm.provider}
                    onChange={(e) => {
                      const nextProv = e.target.value;
                      const firstModel = models.find((m) => m.provider === nextProv && m.kind === "llm")?.model || "";
                      setProbeForm((f) => ({ ...f, provider: nextProv, model: firstModel || f.model, connectionId: "" }));
                    }}
                  >
                    <option value="vertex">Google Vertex AI (vertex)</option>
                    <option value="gemini">Google AI Studio (gemini)</option>
                    <option value="vertex-partner">Vertex Partner (vertex-partner)</option>
                  </NativeSelect>
                </div>

                <div className="space-y-1.5">
                  <Label>Model ID</Label>
                  <Input
                    list="probe-model-options"
                    value={probeForm.model}
                    onChange={(e) => setProbeForm((f) => ({ ...f, model: e.target.value }))}
                    placeholder="e.g. gemini-2.5-flash"
                    required
                  />
                  <datalist id="probe-model-options">
                    {providerModelOptions.map((m) => <option key={m.model} value={m.model} />)}
                  </datalist>
                </div>

                {testerTab === "provider" ? (
                  <div className="space-y-1.5">
                    <Label>Saved Connection (optional)</Label>
                    <NativeSelect
                      value={probeForm.connectionId}
                      onChange={(e) => setProbeForm((f) => ({ ...f, connectionId: e.target.value }))}
                    >
                      <option value="">Auto-select active connection</option>
                      {matchingConns.map((c) => (
                        <option key={c.id} value={c.id}>{c.name} ({c.isActive ? "active" : "disabled"})</option>
                      ))}
                    </NativeSelect>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label>Gateway API Key (sk-9r_...)</Label>
                    <Input
                      type="password"
                      className="font-mono"
                      placeholder="sk-9r_..."
                      value={probeForm.gatewayApiKey}
                      onChange={(e) => setProbeForm((f) => ({ ...f, gatewayApiKey: e.target.value }))}
                      required
                    />
                  </div>
                )}
              </div>

              {testerTab === "provider" && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>Ad-hoc Credential (optional — tests without saving to DB)</Label>
                    <Textarea
                      rows={2}
                      className="font-mono min-h-[60px]"
                      placeholder="Leave blank to use saved connection, OR paste AI Studio key / Vertex SA JSON to test directly"
                      value={probeForm.apiKey}
                      onChange={(e) => setProbeForm((f) => ({ ...f, apiKey: e.target.value }))}
                    />
                  </div>
                  {probeForm.provider.startsWith("vertex") && (
                    <div className="space-y-2">
                      <div className="space-y-1">
                        <Label>Project ID (optional)</Label>
                        <Input placeholder="From SA JSON" value={probeForm.projectId} onChange={(e) => setProbeForm((f) => ({ ...f, projectId: e.target.value }))} />
                      </div>
                      <div className="space-y-1">
                        <Label>Location</Label>
                        <Input placeholder="us-central1" value={probeForm.location} onChange={(e) => setProbeForm((f) => ({ ...f, location: e.target.value }))} />
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-1.5">
                  <Label>Test Prompt</Label>
                  <Input
                    value={probeForm.prompt}
                    onChange={(e) => setProbeForm((f) => ({ ...f, prompt: e.target.value }))}
                    placeholder="Reply with OK."
                  />
                </div>
                {testerTab === "gateway" && (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground pb-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={probeForm.runUpstream}
                      onChange={(e) => setProbeForm((f) => ({ ...f, runUpstream: e.target.checked }))}
                    />
                    Also probe upstream model
                  </label>
                )}
                <Button type="submit" disabled={testerRunning} className="w-full sm:w-auto">
                  {testerRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  {testerRunning ? "Probing..." : "Run Probe"}
                </Button>
              </div>
            </form>

            {testerResult && (
              <div className={`rounded-lg border p-3.5 text-xs space-y-2 ${testerResult.ok ? "border-emerald-500/40 bg-emerald-500/5" : "border-destructive/40 bg-destructive/5"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge variant={testerResult.ok ? "success" : "destructive"}>
                      {testerResult.ok ? `PASS · HTTP ${testerResult.status || 200}` : `FAIL · HTTP ${testerResult.status || "ERR"}`}
                    </Badge>
                    {testerResult.connectionName && <span className="font-mono text-muted-foreground">{testerResult.connectionName}</span>}
                  </div>
                  <span className="font-mono font-semibold">{fmtMs(testerResult.latencyMs)}</span>
                </div>

                {testerResult.gatewayKeyCheck && (
                  <div className="flex flex-wrap gap-2 text-[11px] font-mono text-muted-foreground">
                    <span>Key: {testerResult.gatewayKeyCheck.name || "invalid"} ({testerResult.gatewayKeyCheck.keyHint || "—"})</span>
                    <span>· RPM: {testerResult.gatewayKeyCheck.rpmLimit || "∞"}</span>
                    <span>· Daily Cap: {testerResult.gatewayKeyCheck.dailyBudgetUsd ? `$${testerResult.gatewayKeyCheck.dailyBudgetUsd}` : "∞"}</span>
                    <span>· Allow-list: {testerResult.gatewayKeyCheck.modelAllowed ? "allowed" : "blocked"}</span>
                  </div>
                )}

                {testerResult.preview && (
                  <div className="rounded-md bg-background/80 border p-2.5 font-mono text-[11px] whitespace-pre-wrap break-words">
                    {testerResult.preview}
                  </div>
                )}

                {testerResult.usage && (
                  <div className="text-[11px] font-mono text-muted-foreground">
                    Tokens — prompt: {testerResult.usage.promptTokens}, cached: {testerResult.usage.cachedTokens}, completion: {testerResult.usage.completionTokens}
                  </div>
                )}

                {testerResult.error && (
                  <div className="font-mono text-[11px] text-destructive break-words">{testerResult.error}</div>
                )}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Optional Add Custom Model Form */}
      {showCustomForm && (
        <Card>
          <CardHeader><CardTitle>Add Custom Model</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={handleAddCustom} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <NativeSelect value={customForm.providerAlias} onChange={(e) => setCustomForm((f) => ({ ...f, providerAlias: e.target.value }))}>
                <option value="vertex">vertex</option>
                <option value="gemini">gemini</option>
                <option value="vertex-partner">vertex-partner</option>
              </NativeSelect>
              <Input placeholder="Model ID (e.g. gemini-2.5-pro-exp)" value={customForm.id} onChange={(e) => setCustomForm((f) => ({ ...f, id: e.target.value }))} required />
              <NativeSelect value={customForm.type} onChange={(e) => setCustomForm((f) => ({ ...f, type: e.target.value }))}>
                <option value="llm">llm</option>
                <option value="embedding">embedding</option>
                <option value="image">image</option>
                <option value="tts">tts</option>
                <option value="stt">stt</option>
                <option value="video">video</option>
              </NativeSelect>
              <Button type="submit"><Plus className="h-3.5 w-3.5" /> Add Model</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Search & Filter Bar */}
      <Card>
        <CardContent className="p-3 flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-3 sm:top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search models..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TabsList>
              {[
                { id: "all", label: "All" },
                { id: "vertex", label: "Vertex" },
                { id: "gemini", label: "AI Studio" },
                { id: "vertex-partner", label: "Partner" },
              ].map((p) => (
                <TabsTrigger key={p.id} active={providerFilter === p.id} onClick={() => setProviderFilter(p.id)}>
                  {p.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <NativeSelect className="w-32" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
              <option value="all">All Kinds</option>
              <option value="llm">LLM</option>
              <option value="embedding">Embedding</option>
              <option value="image">Image</option>
              <option value="tts">TTS</option>
              <option value="stt">STT</option>
              <option value="video">Video</option>
            </NativeSelect>
          </div>
        </CardContent>
      </Card>

      {/* Mobile Card List (< md) */}
      <div className="space-y-2.5 md:hidden">
        {filtered.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-xs text-muted-foreground">No models match your filter.</CardContent></Card>
        ) : (
          filtered.map((m) => {
            const pKey = `${m.provider}/${m.model}/${m.kind}`;
            const probe = probeMap[pKey];
            return (
              <Card key={pKey} className={m.disabled ? "opacity-60" : ""}>
                <CardContent className="p-3.5 space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary">{m.provider}</Badge>
                        <Badge variant="outline">{m.kind}</Badge>
                        {m.disabled && <Badge variant="warning">disabled</Badge>}
                        {!m.hasActiveConnection && <Badge variant="destructive">no key</Badge>}
                      </div>
                      <div className="mt-1.5 font-mono text-xs font-semibold break-all">{m.model}</div>
                      <div className="text-[11px] text-muted-foreground">{m.name}</div>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => copyModelId(m.fullModel)} title="Copy model ID">
                      {copiedId === m.fullModel ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground font-mono">
                    <span>
                      {m.pricing
                        ? `$${Number(m.pricing.input || 0).toFixed(2)} / $${Number(m.pricing.output || 0).toFixed(2)} per 1M`
                        : "Rate not synced"}
                    </span>
                    {probe && !probe.running && (
                      <Badge variant={probe.ok ? "success" : "destructive"}>
                        {probe.ok ? `OK · ${fmtMs(probe.latencyMs)}` : `ERR ${probe.status || ""}`}
                      </Badge>
                    )}
                  </div>

                  {probe && !probe.running && (probe.error || probe.preview) && (
                    <div className={`rounded border px-2.5 py-1.5 font-mono text-[11px] break-words ${probe.ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-destructive/30 bg-destructive/5 text-destructive"}`}>
                      {probe.ok ? probe.preview : probe.error}
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      variant="default"
                      size="sm"
                      className="flex-1"
                      disabled={probe?.running}
                      onClick={() => probeSingle(m)}
                    >
                      {probe?.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      Probe
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleToggleDisabled(m)}>
                      <Power className="h-3.5 w-3.5" /> {m.disabled ? "Enable" : "Disable"}
                    </Button>
                    {m.custom && (
                      <Button variant="ghost" size="icon" className="text-destructive" onClick={() => handleDeleteCustom(m)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Desktop Table (>= md) */}
      <Card className="hidden md:block">
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider / Model</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Connection</TableHead>
                <TableHead className="text-right">Live Rate (In / Out)</TableHead>
                <TableHead>Probe Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No models match your filter.</TableCell></TableRow>
              ) : (
                filtered.map((m) => {
                  const pKey = `${m.provider}/${m.model}/${m.kind}`;
                  const probe = probeMap[pKey];
                  return (
                    <TableRow key={pKey} className={m.disabled ? "opacity-55" : ""}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary">{m.provider}</Badge>
                          <span className="font-mono font-medium">{m.model}</span>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground cursor-pointer"
                            onClick={() => copyModelId(m.fullModel)}
                            title={`Copy ${m.fullModel}`}
                          >
                            {copiedId === m.fullModel ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                          </button>
                        </div>
                        <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2">
                          <span>{m.name}</span>
                          {m.caps?.vision && <Badge variant="outline" className="text-[9px] px-1.5 py-0">vision</Badge>}
                          {m.caps?.reasoning && <Badge variant="outline" className="text-[9px] px-1.5 py-0">thinking</Badge>}
                        </div>
                      </TableCell>
                      <TableCell><Badge variant="outline">{m.kind}</Badge></TableCell>
                      <TableCell>
                        <Badge variant={m.hasActiveConnection ? "success" : "warning"}>
                          {m.hasActiveConnection ? `${m.activeConnections} active` : "No key"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
                        {m.pricing ? `$${Number(m.pricing.input || 0).toFixed(2)} / $${Number(m.pricing.output || 0).toFixed(2)}` : "—"}
                      </TableCell>
                      <TableCell className="max-w-[240px]">
                        {probe?.running ? (
                          <span className="inline-flex items-center gap-1.5 text-muted-foreground text-[11px]">
                            <Loader2 className="h-3 w-3 animate-spin" /> Probing...
                          </span>
                        ) : probe ? (
                          <div className="space-y-0.5">
                            <Badge variant={probe.ok ? "success" : "destructive"}>
                              {probe.ok ? `OK · ${fmtMs(probe.latencyMs)}` : `ERR ${probe.status || ""}`}
                            </Badge>
                            <div className="truncate text-[10px] font-mono text-muted-foreground" title={probe.ok ? probe.preview : probe.error}>
                              {probe.ok ? probe.preview : probe.error}
                            </div>
                          </div>
                        ) : (
                          <span className="text-[11px] text-muted-foreground">Not probed</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-1 whitespace-nowrap">
                        <Button variant="outline" size="sm" disabled={probe?.running} onClick={() => probeSingle(m)}>
                          <Play className="h-3 w-3" /> Probe
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleToggleDisabled(m)}>
                          {m.disabled ? "Enable" : "Disable"}
                        </Button>
                        {m.custom && (
                          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => handleDeleteCustom(m)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

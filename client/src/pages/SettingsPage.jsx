import { useState, useEffect, useCallback } from "react";
import { HardDrive, Shield, Download, Save, CloudDownload, Plus, RotateCcw, DollarSign } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fmtBytes } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, NativeSelect } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export function SettingsPage() {
  const [backups, setBackups] = useState([]);
  const [disk, setDisk] = useState(null);
  const [pricingData, setPricingData] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const [dailyCap, setDailyCap] = useState("");
  const [monthlyCap, setMonthlyCap] = useState("");
  const [pwForm, setPwForm] = useState({ currentPassword: "", newPassword: "" });
  const [rateForm, setRateForm] = useState({
    provider: "vertex",
    model: "",
    input: "",
    output: "",
    cached: "",
    cache_creation: "",
  });

  const load = useCallback(async () => {
    const [s, b, p] = await Promise.all([
      apiFetch("/api/settings"),
      apiFetch("/api/backups"),
      apiFetch("/api/pricing"),
    ]);
    setDailyCap(s.globalDailyBudgetUsd ?? "");
    setMonthlyCap(s.globalMonthlyBudgetUsd ?? "");
    setBackups(b.backups || []);
    setDisk({
      configBytes: b.config?.totalBytes ?? b.disk?.configBytes ?? 0,
      telemetryBytes: b.telemetry?.totalBytes ?? b.disk?.telemetryBytes ?? 0,
      payloadsBytes: b.payloads?.totalBytes ?? b.disk?.payloadsBytes ?? 0,
    });
    setPricingData(p);
  }, []);

  useEffect(() => { load().catch(() => {}); }, [load]);

  async function saveBudgets(e) {
    e.preventDefault();
    setMsg(""); setErr("");
    try {
      await apiFetch("/api/settings", {
        method: "PATCH",
        body: {
          globalDailyBudgetUsd: dailyCap === "" ? null : Number(dailyCap),
          globalMonthlyBudgetUsd: monthlyCap === "" ? null : Number(monthlyCap),
        },
      });
      setMsg("Global budget caps updated.");
      load();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function rotatePassword(e) {
    e.preventDefault();
    setMsg(""); setErr("");
    try {
      await apiFetch("/api/settings", { method: "PATCH", body: pwForm });
      setPwForm({ currentPassword: "", newPassword: "" });
      setMsg("Admin password rotated (all previous sessions revoked).");
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function handleSyncPricing() {
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
    if (!rateForm.model.trim()) return setErr("Model ID is required");
    try {
      const res = await apiFetch("/api/pricing", {
        method: "PATCH",
        body: {
          [rateForm.provider]: {
            [rateForm.model.trim()]: {
              input: Number(rateForm.input || 0),
              output: Number(rateForm.output || 0),
              cached: Number(rateForm.cached || rateForm.input || 0),
              cache_creation: Number(rateForm.cache_creation || rateForm.input || 0),
            },
          },
        },
      });
      setPricingData(res);
      setRateForm((f) => ({ ...f, model: "", input: "", output: "", cached: "", cache_creation: "" }));
      setMsg(`Saved manual pricing override for ${rateForm.provider}/${rateForm.model.trim()}.`);
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function handleResetOverride(provider, model) {
    setMsg(""); setErr("");
    try {
      const qs = provider && model
        ? `?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`
        : "";
      const res = await apiFetch(`/api/pricing${qs}`, { method: "DELETE" });
      setPricingData(res);
      setMsg(model ? `Reset override for ${provider}/${model}.` : "All manual pricing overrides reset.");
    } catch (e) {
      setErr(e.message);
    }
  }

  async function triggerBackup(target) {
    setMsg(""); setErr("");
    try {
      const res = await apiFetch("/api/backups", { method: "POST", body: { target } });
      const b = res.backup || res;
      setMsg(`Atomic VACUUM INTO backup created: ${b?.filename} (${fmtBytes(b?.bytes)})`);
      load();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  const overridesList = [];
  for (const [provider, models] of Object.entries(pricingData?.overrides || {})) {
    for (const [model, rate] of Object.entries(models || {})) {
      overridesList.push({ provider, model, ...rate });
    }
  }
  const lastSync = pricingData?.meta?.syncedAt || pricingData?.syncState?.lastSync;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Settings, Pricing &amp; Backups</h2>
        <p className="text-xs text-muted-foreground">Manage pricing overrides, global budget caps, admin password, and 3-file SQLite atomic backups</p>
      </div>

      {msg && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">{msg}</div>}
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</div>}

      {/* Pricing Management (Moved here from Cost page) */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><DollarSign className="h-4 w-4 text-emerald-500" /> Dynamic Pricing &amp; Manual Overrides</CardTitle>
            <CardDescription className="mt-0.5">
              Synced daily from models.dev/api.json {lastSync ? `· Last sync: ${new Date(lastSync).toLocaleString()}` : "· Not synced yet"}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="default" size="sm" onClick={handleSyncPricing} disabled={syncing}>
              <CloudDownload className={`h-3.5 w-3.5 ${syncing ? "animate-bounce" : ""}`} />
              {syncing ? "Syncing..." : "Sync Live Pricing"}
            </Button>
            {overridesList.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => handleResetOverride()}>
                <RotateCcw className="h-3.5 w-3.5" /> Reset All
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={handleSaveOverride} className="grid grid-cols-2 gap-2.5 rounded-lg border bg-muted/25 p-3.5 lg:grid-cols-6">
            <div className="space-y-1 col-span-2 lg:col-span-1">
              <Label>Provider</Label>
              <NativeSelect value={rateForm.provider} onChange={(e) => setRateForm((f) => ({ ...f, provider: e.target.value }))}>
                <option value="vertex">vertex</option>
                <option value="gemini">gemini</option>
                <option value="vertex-partner">vertex-partner</option>
              </NativeSelect>
            </div>
            <div className="space-y-1 col-span-2 lg:col-span-2">
              <Label>Model ID</Label>
              <Input placeholder="e.g. gemini-4-carbon" value={rateForm.model} onChange={(e) => setRateForm((f) => ({ ...f, model: e.target.value }))} required />
            </div>
            <div className="space-y-1">
              <Label>Input ($/1M)</Label>
              <Input type="number" step="any" placeholder="4.00" value={rateForm.input} onChange={(e) => setRateForm((f) => ({ ...f, input: e.target.value }))} required />
            </div>
            <div className="space-y-1">
              <Label>Output ($/1M)</Label>
              <Input type="number" step="any" placeholder="20.00" value={rateForm.output} onChange={(e) => setRateForm((f) => ({ ...f, output: e.target.value }))} required />
            </div>
            <div className="space-y-1">
              <Label>Cache Read</Label>
              <Input type="number" step="any" placeholder="0.20" value={rateForm.cached} onChange={(e) => setRateForm((f) => ({ ...f, cached: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>Cache Write</Label>
              <Input type="number" step="any" placeholder="Optional" value={rateForm.cache_creation} onChange={(e) => setRateForm((f) => ({ ...f, cache_creation: e.target.value }))} />
            </div>
            <div className="col-span-2 lg:col-span-5 flex items-end">
              <Button type="submit" className="w-full sm:w-auto"><Plus className="h-3.5 w-3.5" /> Save Override</Button>
            </div>
          </form>

          {overridesList.length === 0 ? (
            <p className="text-xs text-muted-foreground">No manual overrides configured. All models use live rates synced from models.dev.</p>
          ) : (
            <>
              <div className="space-y-2 md:hidden">
                {overridesList.map((r) => (
                  <div key={`${r.provider}/${r.model}`} className="rounded-lg border p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-mono text-xs font-medium truncate">
                        <Badge variant="warning" className="mr-1.5">{r.provider}</Badge>
                        {r.model}
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => handleResetOverride(r.provider, r.model)}>
                        <RotateCcw className="h-3 w-3" /> Reset
                      </Button>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[11px] font-mono text-muted-foreground">
                      <div>In: <span className="text-foreground">${Number(r.input || 0).toFixed(4)}</span></div>
                      <div>Cache: <span className="text-sky-600 dark:text-sky-400">${Number(r.cached ?? r.input ?? 0).toFixed(4)}</span></div>
                      <div>Out: <span className="text-foreground">${Number(r.output || 0).toFixed(4)}</span></div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider / Model</TableHead>
                      <TableHead className="text-right">Input</TableHead>
                      <TableHead className="text-right">Cached</TableHead>
                      <TableHead className="text-right">Output</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overridesList.map((r) => (
                      <TableRow key={`${r.provider}/${r.model}`}>
                        <TableCell className="font-mono whitespace-nowrap"><Badge variant="warning" className="mr-2">{r.provider}</Badge>{r.model}</TableCell>
                        <TableCell className="text-right font-mono">${Number(r.input || 0).toFixed(4)}</TableCell>
                        <TableCell className="text-right font-mono text-sky-600 dark:text-sky-400">${Number(r.cached ?? r.input ?? 0).toFixed(4)}</TableCell>
                        <TableCell className="text-right font-mono">${Number(r.output || 0).toFixed(4)}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => handleResetOverride(r.provider, r.model)}>
                            <RotateCcw className="h-3 w-3" /> Reset
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Global Spend Guardrails</CardTitle>
            <CardDescription>Hard ceiling across all API keys combined (enforced with atomic in-flight pre-reservation).</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveBudgets} className="space-y-3">
              <div className="space-y-1.5">
                <Label>Global Daily Cap (USD)</Label>
                <Input type="number" step="0.01" placeholder="Unlimited" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Global Monthly Cap (USD)</Label>
                <Input type="number" step="0.01" placeholder="Unlimited" value={monthlyCap} onChange={(e) => setMonthlyCap(e.target.value)} />
              </div>
              <Button type="submit" className="w-full sm:w-auto"><Save className="h-3.5 w-3.5" /> Save Guardrails</Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Shield className="h-4 w-4" /> Rotate Admin Password</CardTitle>
            <CardDescription>Bcrypt cost 12. Rotating immediately increments sessionVersion and invalidates all other cookies.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={rotatePassword} className="space-y-3">
              <div className="space-y-1.5">
                <Label>Current Password</Label>
                <Input type="password" required value={pwForm.currentPassword} onChange={(e) => setPwForm((f) => ({ ...f, currentPassword: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>New Password (min 12 chars)</Label>
                <Input type="password" required minLength={12} value={pwForm.newPassword} onChange={(e) => setPwForm((f) => ({ ...f, newPassword: e.target.value }))} />
              </div>
              <Button type="submit" variant="outline" className="w-full sm:w-auto">Rotate Password</Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><HardDrive className="h-4 w-4" /> 3-File Split SQLite &amp; Atomic Backups</CardTitle>
            <CardDescription className="mt-0.5">
              Retention: Forever · config {fmtBytes(disk?.configBytes)} · telemetry {fmtBytes(disk?.telemetryBytes)} · payloads {fmtBytes(disk?.payloadsBytes)}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => triggerBackup("config")}><Download className="h-3.5 w-3.5" /> Backup Config</Button>
            <Button variant="outline" size="sm" onClick={() => triggerBackup("telemetry")}><Download className="h-3.5 w-3.5" /> Backup Telemetry</Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y md:hidden">
            {backups.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">No backups yet.</div>
            ) : (
              backups.map((b) => (
                <div key={b.filename} className="px-4 py-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-mono text-xs font-medium truncate">{b.filename}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{fmtBytes(b.bytes)} · {new Date(b.createdAt).toLocaleDateString()}</div>
                  </div>
                  <a
                    href={`/api/backups?download=${encodeURIComponent(b.filename)}`}
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border hover:bg-accent"
                    title="Download SQLite backup"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </a>
                </div>
              ))
            )}
          </div>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Backup File</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                  <TableHead className="text-right">Download</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {backups.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="py-6 text-center text-muted-foreground">No backups yet (daily automatic backup runs for config.sqlite).</TableCell></TableRow>
                ) : (
                  backups.map((b) => (
                    <TableRow key={b.filename}>
                      <TableCell className="font-mono whitespace-nowrap"><Badge variant="secondary" className="mr-2">SQLite</Badge>{b.filename}</TableCell>
                      <TableCell className="text-right font-mono">{fmtBytes(b.bytes)}</TableCell>
                      <TableCell className="text-right font-mono text-muted-foreground">{new Date(b.createdAt).toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <a
                          href={`/api/backups?download=${encodeURIComponent(b.filename)}`}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-accent"
                        >
                          <Download className="h-3 w-3" /> SQLite
                        </a>
                      </TableCell>
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

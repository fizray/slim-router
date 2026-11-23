import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Copy, Check, KeyRound } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fmtNum } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export function ApiKeysPage() {
  const [keys, setKeys] = useState([]);
  const [createdKey, setCreatedKey] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    name: "",
    rpmLimit: "",
    tpmLimit: "",
    dailyBudgetUsd: "",
    monthlyBudgetUsd: "",
    allowModels: "",
  });

  const load = useCallback(async () => {
    const data = await apiFetch("/api/keys");
    setKeys(data.keys || []);
  }, []);

  useEffect(() => { load().catch(() => {}); }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    setErr(""); setCreatedKey("");
    const allow = form.allowModels.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      const res = await apiFetch("/api/keys", {
        method: "POST",
        body: {
          name: form.name || "Client Key",
          rpmLimit: form.rpmLimit ? Number(form.rpmLimit) : null,
          tpmLimit: form.tpmLimit ? Number(form.tpmLimit) : null,
          dailyBudgetUsd: form.dailyBudgetUsd ? Number(form.dailyBudgetUsd) : null,
          monthlyBudgetUsd: form.monthlyBudgetUsd ? Number(form.monthlyBudgetUsd) : null,
          access: allow.length ? { restricted: true, allow } : { restricted: false, allow: [] },
        },
      });
      setCreatedKey(res.key || "");
      setForm({ name: "", rpmLimit: "", tpmLimit: "", dailyBudgetUsd: "", monthlyBudgetUsd: "", allowModels: "" });
      load();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function handleDelete(id) {
    await apiFetch(`/api/keys/${id}`, { method: "DELETE" });
    load();
  }

  function copyVal(id, text) {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(""), 1600);
  }

  const origin = window.location.origin;
  const endpoints = [
    { id: "oai", label: "OpenAI-Compatible", url: `${origin}/v1` },
    { id: "ant", label: "Anthropic / Claude SDK", url: `${origin}/v1/messages` },
    { id: "gem", label: "Native Gemini SDK", url: `${origin}/v1beta` },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">API Keys &amp; Governance Policies</h2>
        <p className="text-xs text-muted-foreground">Zero-plaintext HMAC-SHA256 keys (sk-9r_...) with RPM/TPM rate limits, USD budget caps, and model allow-lists</p>
      </div>

      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</div>}

      {createdKey && (
        <Card className="border-emerald-500/40 bg-emerald-500/5">
          <CardContent className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1 min-w-0">
              <div className="text-xs font-semibold text-emerald-500">Copy your new API key now — it will never be shown again!</div>
              <code className="block break-all font-mono text-xs">{createdKey}</code>
            </div>
            <Button variant="outline" size="sm" onClick={() => copyVal("new-key", createdKey)} className="shrink-0">
              {copiedId === "new-key" ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              {copiedId === "new-key" ? "Copied" : "Copy"}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> Create Governed API Key</CardTitle>
          <CardDescription>All inference endpoints require a valid Bearer token or x-goog-api-key header (zero localhost bypass).</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Key Name</Label>
              <Input placeholder="e.g. Claude Code / Cursor / Personal App" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>RPM Limit</Label>
              <Input type="number" placeholder="Unlimited" value={form.rpmLimit} onChange={(e) => setForm((f) => ({ ...f, rpmLimit: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>TPM Limit</Label>
              <Input type="number" placeholder="Unlimited" value={form.tpmLimit} onChange={(e) => setForm((f) => ({ ...f, tpmLimit: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Daily Budget Cap (USD)</Label>
              <Input type="number" step="0.01" placeholder="e.g. 5.00" value={form.dailyBudgetUsd} onChange={(e) => setForm((f) => ({ ...f, dailyBudgetUsd: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Monthly Budget Cap (USD)</Label>
              <Input type="number" step="0.01" placeholder="e.g. 50.00" value={form.monthlyBudgetUsd} onChange={(e) => setForm((f) => ({ ...f, monthlyBudgetUsd: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Allowed Models (comma-separated)</Label>
              <Input placeholder="Leave blank for all" value={form.allowModels} onChange={(e) => setForm((f) => ({ ...f, allowModels: e.target.value }))} />
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <Button type="submit" className="w-full sm:w-auto"><Plus className="h-3.5 w-3.5" /> Generate API Key</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Mobile card list (< md) */}
      <div className="space-y-2.5 md:hidden">
        {keys.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-xs text-muted-foreground">No API keys created yet.</CardContent></Card>
        ) : (
          keys.map((k) => (
            <Card key={k.id}>
              <CardContent className="p-3.5 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-xs">{k.name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground">{k.keyHint}</div>
                  </div>
                  <Button variant="ghost" size="icon" className="text-destructive" onClick={() => handleDelete(k.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-muted-foreground">
                  <span>RPM: {k.rpmLimit || "∞"}</span>
                  <span>· TPM: {k.tpmLimit || "∞"}</span>
                  <span>· Cap: {k.dailyBudgetUsd ? `$${k.dailyBudgetUsd}/d` : "∞"}</span>
                  <Badge variant={k.access?.restricted ? "warning" : "secondary"}>
                    {k.access?.restricted ? `${k.access.allow?.length || 0} models` : "All models"}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Desktop table (>= md) */}
      <Card className="hidden md:block">
        <CardHeader><CardTitle>Active Keys ({keys.length})</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Hint</TableHead>
                <TableHead>RPM / TPM</TableHead>
                <TableHead>Daily / Monthly Cap</TableHead>
                <TableHead>Model Access</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No API keys created yet.</TableCell></TableRow>
              ) : (
                keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell className="font-medium">{k.name}</TableCell>
                    <TableCell className="font-mono text-muted-foreground">{k.keyHint}</TableCell>
                    <TableCell className="font-mono">{k.rpmLimit ? fmtNum(k.rpmLimit) : "∞"} / {k.tpmLimit ? fmtNum(k.tpmLimit) : "∞"}</TableCell>
                    <TableCell className="font-mono">{k.dailyBudgetUsd ? `$${k.dailyBudgetUsd}` : "∞"} / {k.monthlyBudgetUsd ? `$${k.monthlyBudgetUsd}` : "∞"}</TableCell>
                    <TableCell>
                      <Badge variant={k.access?.restricted ? "warning" : "secondary"}>
                        {k.access?.restricted ? `${k.access.allow?.length || 0} allowed` : "All models"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => handleDelete(k.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Gateway Endpoints</CardTitle>
          <CardDescription>Tap to copy base URL for OpenAI, Anthropic, or Google Gemini SDKs.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-2.5 text-xs md:grid-cols-3">
          {endpoints.map((ep) => (
            <button
              key={ep.id}
              type="button"
              onClick={() => copyVal(ep.id, ep.url)}
              className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 p-3 text-left hover:bg-muted/60 transition-colors cursor-pointer"
            >
              <div className="min-w-0">
                <div className="text-[10.5px] font-medium text-muted-foreground mb-1">{ep.label}</div>
                <div className="font-mono text-[11.5px] truncate">{ep.url}</div>
              </div>
              {copiedId === ep.id ? <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0" /> : <Copy className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
            </button>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

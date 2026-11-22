import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, Copy, Check, KeyRound } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export function ApiKeysPage() {
  const [keys, setKeys] = useState([]);
  const [createdKey, setCreatedKey] = useState("");
  const [copied, setCopied] = useState(false);
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

  function copyKey() {
    navigator.clipboard.writeText(createdKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  const origin = window.location.origin;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">API Keys &amp; Governance Policies</h2>
        <p className="text-xs text-muted-foreground">Zero-plaintext HMAC-SHA256 keys (sk-9r_...) with RPM/TPM rate limits, USD budget caps, and model allow-lists</p>
      </div>

      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</div>}

      {createdKey && (
        <Card className="border-emerald-500/40 bg-emerald-500/5">
          <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <div className="text-xs font-semibold text-emerald-500">Copy your new API key now — it will never be shown again!</div>
              <code className="block truncate font-mono text-xs">{createdKey}</code>
            </div>
            <Button variant="outline" size="sm" onClick={copyKey}>
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
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
          <form onSubmit={handleCreate} className="grid grid-cols-1 gap-3 md:grid-cols-3">
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
            <div className="md:col-span-3">
              <Button type="submit"><Plus className="h-3.5 w-3.5" /> Generate API Key</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
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
                    <TableCell className="font-mono">{k.rpmLimit || "∞"} / {k.tpmLimit || "∞"}</TableCell>
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
          <CardDescription>Point any OpenAI, Anthropic, or Google Gemini SDK to these base URLs.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-2 font-mono text-xs md:grid-cols-3">
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="text-[10px] text-muted-foreground mb-1">OpenAI-Compatible</div>
            <div className="truncate">{origin}/v1</div>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="text-[10px] text-muted-foreground mb-1">Anthropic / Claude SDK</div>
            <div className="truncate">{origin}/v1/messages</div>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="text-[10px] text-muted-foreground mb-1">Native Gemini SDK</div>
            <div className="truncate">{origin}/v1beta</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

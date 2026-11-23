import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, CheckCircle2, Power, ShieldCheck } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea, Label, NativeSelect } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

const GOOGLE_PROVIDERS = [
  { id: "vertex", name: "Google Vertex AI (Gemini & Veo)", hint: "Paste GCP Service Account JSON, ADC JSON, or Vertex AI API Key" },
  { id: "gemini", name: "Google AI Studio (Gemini API Key)", hint: "AIza... (from https://aistudio.google.com/app/apikey)" },
  { id: "vertex-partner", name: "Google Vertex AI Partner Models (MaaS)", hint: "GCP Service Account JSON / ADC JSON (Claude, DeepSeek, Qwen, GLM on Vertex)" },
];

export function ProvidersPage() {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [form, setForm] = useState({
    provider: "vertex",
    name: "",
    apiKey: "",
    projectId: "",
    location: "us-central1",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/api/providers");
      setConnections(data.connections || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load().catch(() => {}); }, [load]);

  async function handleAdd(e) {
    e.preventDefault();
    setMsg(""); setErr("");
    const providerSpecificData = {};
    if (form.projectId.trim()) providerSpecificData.projectId = form.projectId.trim();
    if (form.location.trim() && form.provider.startsWith("vertex")) {
      providerSpecificData.location = form.location.trim();
    }
    try {
      const res = await apiFetch("/api/providers", {
        method: "POST",
        body: {
          provider: form.provider,
          name: form.name || `${form.provider} connection`,
          apiKey: form.apiKey,
          providerSpecificData,
        },
      });
      setMsg(`Encrypted & saved: ${res.connection?.name}`);
      setForm((f) => ({ ...f, name: "", apiKey: "" }));
      load();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function handleTest(id) {
    setMsg(""); setErr("");
    try {
      const res = await apiFetch(`/api/providers/${id}/test`, { method: "POST" });
      if (res.valid) setMsg("Connection verified successfully.");
      else setErr(res.error || "Connection test failed");
      load();
    } catch (e) {
      setErr(e.message);
    }
  }

  async function handleToggle(c) {
    await apiFetch(`/api/providers/${c.id}`, { method: "PUT", body: { isActive: !c.isActive } });
    load();
  }

  async function handleDelete(id) {
    await apiFetch(`/api/providers/${id}`, { method: "DELETE" });
    load();
  }

  const meta = GOOGLE_PROVIDERS.find((p) => p.id === form.provider);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Vertex AI &amp; Google AI Studio Connections</h2>
        <p className="text-xs text-muted-foreground">Credentials are encrypted at rest with AES-256-GCM + AAD in config.sqlite and masked in all API responses</p>
      </div>

      {msg && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">{msg}</div>}
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-500" /> Add Encrypted Connection</CardTitle>
          <CardDescription>Add multiple accounts/keys per provider for automatic failover and load distribution.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <NativeSelect value={form.provider} onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}>
                {GOOGLE_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label>Connection Name</Label>
              <Input placeholder="e.g. Vertex Prod / AI Studio Key 1" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label>Credential (Encrypted at Rest)</Label>
              <Textarea
                rows={form.provider.startsWith("vertex") ? 4 : 2}
                className="font-mono"
                placeholder={meta?.hint}
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                required
              />
            </div>
            {form.provider.startsWith("vertex") && (
              <>
                <div className="space-y-1.5">
                  <Label>GCP Project ID</Label>
                  <Input placeholder="Optional if included in SA JSON" value={form.projectId} onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>Vertex Location</Label>
                  <Input placeholder="us-central1 or global" value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} />
                </div>
              </>
            )}
            <div className="md:col-span-2">
              <Button type="submit" className="w-full sm:w-auto"><Plus className="h-3.5 w-3.5" /> Encrypt &amp; Save Connection</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Mobile card list (< md) */}
      <div className="space-y-2.5 md:hidden">
        {loading && connections.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-xs text-muted-foreground">Loading...</CardContent></Card>
        ) : connections.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-xs text-muted-foreground">No connections configured yet.</CardContent></Card>
        ) : (
          connections.map((c) => (
            <Card key={c.id}>
              <CardContent className="p-3.5 space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <Badge variant="secondary">{c.provider}</Badge>
                      <Badge variant={c.isActive && c.testStatus !== "error" ? "success" : "warning"}>
                        {c.isActive ? (c.testStatus || "active") : "disabled"}
                      </Badge>
                    </div>
                    <div className="mt-1 font-medium text-xs">{c.name}</div>
                    <div className="font-mono text-[11px] text-muted-foreground truncate">{c.apiKeyMasked || (c.hasSecret ? "encrypted" : "—")}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => handleTest(c.id)}>
                    <CheckCircle2 className="h-3.5 w-3.5" /> Test
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => handleToggle(c)}>
                    <Power className="h-3.5 w-3.5" /> {c.isActive ? "Disable" : "Enable"}
                  </Button>
                  <Button variant="ghost" size="icon" className="text-destructive" onClick={() => handleDelete(c.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Desktop table (>= md) */}
      <Card className="hidden md:block">
        <CardHeader><CardTitle>Configured Connections ({connections.length})</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Masked Secret</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Priority</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && connections.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">Loading...</TableCell></TableRow>
              ) : connections.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No connections configured yet.</TableCell></TableRow>
              ) : (
                connections.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono font-medium"><Badge variant="secondary">{c.provider}</Badge></TableCell>
                    <TableCell>{c.name}</TableCell>
                    <TableCell className="font-mono text-muted-foreground">{c.apiKeyMasked || (c.hasSecret ? "encrypted" : "—")}</TableCell>
                    <TableCell>
                      <Badge variant={c.isActive && c.testStatus !== "error" ? "success" : "warning"}>
                        {c.isActive ? (c.testStatus || "active") : "disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">{c.priority ?? 1}</TableCell>
                    <TableCell className="text-right space-x-1">
                      <Button variant="outline" size="sm" onClick={() => handleTest(c.id)}>
                        <CheckCircle2 className="h-3 w-3" /> Test
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => handleToggle(c)}>
                        <Power className="h-3 w-3" /> {c.isActive ? "Disable" : "Enable"}
                      </Button>
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => handleDelete(c.id)}>
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
    </div>
  );
}

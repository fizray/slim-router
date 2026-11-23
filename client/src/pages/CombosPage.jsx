import { useState, useEffect, useCallback } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, Layers, Tag } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

const PRESET_MODELS = [
  "vertex/gemini-4-hydrogen",
  "vertex/gemini-4-neon",
  "vertex/gemini-4-carbon",
  "vertex/gemini-3.5-flash-lite",
  "vertex/gemini-3.5-transcribe",
  "vertex/gemini-2.5-pro",
  "vertex/gemini-2.5-flash",
  "gemini/gemini-2.5-pro",
  "gemini/gemini-2.5-flash",
  "gemini/gemini-3.5-flash-lite",
  "vertex-partner/deepseek-ai/deepseek-v3.2-maas",
];

export function CombosPage() {
  const [combos, setCombos] = useState([]);
  const [aliases, setAliases] = useState({});
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const [comboName, setComboName] = useState("");
  const [comboModels, setComboModels] = useState(["vertex/gemini-2.5-pro", "gemini/gemini-2.5-pro"]);
  const [newSeat, setNewSeat] = useState("");

  const [aliasName, setAliasName] = useState("");
  const [aliasTarget, setAliasTarget] = useState("vertex/gemini-2.5-flash");

  const load = useCallback(async () => {
    const [cRes, aRes] = await Promise.all([
      apiFetch("/api/combos"),
      apiFetch("/api/models/alias"),
    ]);
    setCombos(cRes.combos || []);
    setAliases(aRes.aliases || {});
  }, []);

  useEffect(() => { load().catch(() => {}); }, [load]);

  function addSeat(m) {
    const clean = m.trim();
    if (!clean || comboModels.includes(clean)) return;
    setComboModels((list) => [...list, clean]);
    setNewSeat("");
  }

  function moveSeat(idx, dir) {
    const target = idx + dir;
    if (target < 0 || target >= comboModels.length) return;
    setComboModels((list) => {
      const next = [...list];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  async function handleCreateCombo(e) {
    e.preventDefault();
    setMsg(""); setErr("");
    if (!comboName.trim() || comboModels.length === 0) return setErr("Combo name and at least 1 model required");
    try {
      await apiFetch("/api/combos", { method: "POST", body: { name: comboName.trim(), models: comboModels } });
      setMsg(`Created combo: ${comboName.trim()}`);
      setComboName("");
      load();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function handleDeleteCombo(id) {
    await apiFetch(`/api/combos/${id}`, { method: "DELETE" });
    load();
  }

  async function handleAddAlias(e) {
    e.preventDefault();
    setMsg(""); setErr("");
    if (!aliasName.trim() || !aliasTarget.trim()) return;
    try {
      await apiFetch("/api/models/alias", { method: "PUT", body: { alias: aliasName.trim(), model: aliasTarget.trim() } });
      setMsg(`Saved alias: ${aliasName.trim()} → ${aliasTarget.trim()}`);
      setAliasName("");
      load();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  async function handleDeleteAlias(a) {
    await apiFetch(`/api/models/alias?alias=${encodeURIComponent(a)}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Model Combos &amp; Aliases</h2>
        <p className="text-xs text-muted-foreground">Chain Vertex AI &amp; AI Studio models for automatic failover, or map short aliases like &quot;smart&quot; or &quot;fast&quot;</p>
      </div>

      {msg && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">{msg}</div>}
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</div>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Layers className="h-4 w-4" /> Create Failover Combo</CardTitle>
            <CardDescription>Requests try models from top to bottom on rate limit or upstream error.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={handleCreateCombo} className="space-y-3">
              <div className="space-y-1.5">
                <Label>Combo Name</Label>
                <Input placeholder="e.g. gemini-pro-ha" value={comboName} onChange={(e) => setComboName(e.target.value)} required />
              </div>

              <div className="space-y-1.5">
                <Label>Fallback Chain ({comboModels.length})</Label>
                <div className="space-y-1.5">
                  {comboModels.map((m, idx) => (
                    <div key={m} className="flex items-center justify-between rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs font-mono">
                      <span><Badge variant="outline" className="mr-2">#{idx + 1}</Badge>{m}</span>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveSeat(idx, -1)}><ArrowUp className="h-3 w-3" /></Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => moveSeat(idx, 1)}><ArrowDown className="h-3 w-3" /></Button>
                        <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={() => setComboModels((l) => l.filter((x) => x !== m))}><Trash2 className="h-3 w-3" /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-2">
                <Input
                  list="vertex-gemini-models"
                  placeholder="Add provider/model (e.g. vertex/gemini-2.5-flash)"
                  value={newSeat}
                  onChange={(e) => setNewSeat(e.target.value)}
                />
                <datalist id="vertex-gemini-models">
                  {PRESET_MODELS.map((m) => <option key={m} value={m} />)}
                </datalist>
                <Button variant="outline" onClick={() => addSeat(newSeat)}>Add</Button>
              </div>

              <Button type="submit"><Plus className="h-3.5 w-3.5" /> Save Combo</Button>
            </form>

            <div className="border-t pt-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Combo</TableHead>
                    <TableHead>Chain</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {combos.length === 0 ? (
                    <TableRow><TableCell colSpan={3} className="py-4 text-center text-muted-foreground">No combos yet.</TableCell></TableRow>
                  ) : (
                    combos.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-mono font-semibold whitespace-nowrap">{c.name}</TableCell>
                        <TableCell className="font-mono text-[11px] text-muted-foreground">{(c.models || []).join(" → ")}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => handleDeleteCombo(c.id)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Tag className="h-4 w-4" /> Model Aliases</CardTitle>
            <CardDescription>Map friendly model names (e.g. gpt-4o or claude-sonnet-4-6) directly to Vertex or AI Studio models.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={handleAddAlias} className="space-y-3">
              <div className="space-y-1.5">
                <Label>Alias Name</Label>
                <Input placeholder="e.g. smart, fast, gpt-4o" value={aliasName} onChange={(e) => setAliasName(e.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label>Target Model</Label>
                <Input list="vertex-gemini-models" placeholder="vertex/gemini-2.5-pro" value={aliasTarget} onChange={(e) => setAliasTarget(e.target.value)} required />
              </div>
              <Button type="submit"><Plus className="h-3.5 w-3.5" /> Save Alias</Button>
            </form>

            <div className="border-t pt-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Alias</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.keys(aliases).length === 0 ? (
                    <TableRow><TableCell colSpan={3} className="py-4 text-center text-muted-foreground">No aliases configured.</TableCell></TableRow>
                  ) : (
                    Object.entries(aliases).map(([a, target]) => (
                      <TableRow key={a}>
                        <TableCell className="font-mono font-semibold">{a}</TableCell>
                        <TableCell className="font-mono text-muted-foreground">{target}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => handleDeleteAlias(a)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
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
    </div>
  );
}

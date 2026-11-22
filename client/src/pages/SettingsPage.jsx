import { useState, useEffect, useCallback } from "react";
import { HardDrive, Shield, Download, Save } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { fmtBytes } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export function SettingsPage() {
  const [settings, setSettings] = useState(null);
  const [backups, setBackups] = useState([]);
  const [disk, setDisk] = useState(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const [dailyCap, setDailyCap] = useState("");
  const [monthlyCap, setMonthlyCap] = useState("");
  const [pwForm, setPwForm] = useState({ currentPassword: "", newPassword: "" });

  const load = useCallback(async () => {
    const [s, b] = await Promise.all([apiFetch("/api/settings"), apiFetch("/api/backups")]);
    setSettings(s);
    setDailyCap(s.globalDailyBudgetUsd ?? "");
    setMonthlyCap(s.globalMonthlyBudgetUsd ?? "");
    setBackups(b.backups || []);
    setDisk(b.disk || null);
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

  async function triggerBackup(target) {
    setMsg(""); setErr("");
    try {
      const res = await apiFetch("/api/backups", { method: "POST", body: { target } });
      setMsg(`Atomic VACUUM INTO backup created: ${res.backup?.filename} (${fmtBytes(res.backup?.bytes)})`);
      load();
    } catch (e2) {
      setErr(e2.message);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Settings, Security &amp; Atomic Backups</h2>
        <p className="text-xs text-muted-foreground">3-file split SQLite storage (retention forever) with daily atomic VACUUM INTO backups</p>
      </div>

      {msg && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">{msg}</div>}
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</div>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Global Spend Guardrails</CardTitle>
            <CardDescription>Hard ceiling across all API keys combined (enforced with in-flight pre-reservation).</CardDescription>
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
              <Button type="submit"><Save className="h-3.5 w-3.5" /> Save Guardrails</Button>
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
              <Button type="submit" variant="outline">Rotate Password</Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><HardDrive className="h-4 w-4" /> 3-File Split SQLite &amp; Atomic Backups</CardTitle>
            <CardDescription>
              Retention: Forever · DB stats: config {fmtBytes(disk?.configBytes)}, telemetry {fmtBytes(disk?.telemetryBytes)}, payloads {fmtBytes(disk?.payloadsBytes)}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => triggerBackup("config")}><Download className="h-3.5 w-3.5" /> Backup Config</Button>
            <Button variant="outline" size="sm" onClick={() => triggerBackup("telemetry")}><Download className="h-3.5 w-3.5" /> Backup Telemetry</Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Backup File</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.length === 0 ? (
                <TableRow><TableCell colSpan={3} className="py-6 text-center text-muted-foreground">No backups yet (daily automatic backup runs for config.sqlite).</TableCell></TableRow>
              ) : (
                backups.map((b) => (
                  <TableRow key={b.filename}>
                    <TableCell className="font-mono"><Badge variant="secondary" className="mr-2">SQLite</Badge>{b.filename}</TableCell>
                    <TableCell className="text-right font-mono">{fmtBytes(b.bytes)}</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">{new Date(b.createdAt).toLocaleString()}</TableCell>
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

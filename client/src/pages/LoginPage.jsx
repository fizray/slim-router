import { useState } from "react";
import { AlertCircle, Eye, EyeOff } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";

export function LoginPage({ onSuccess }) {
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await apiFetch("/api/auth/login", { method: "POST", body: { password } });
      onSuccess();
    } catch (err) {
      setError(err.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background p-4">
      <div className="w-full max-w-[360px] space-y-5">
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-foreground text-background font-mono text-sm font-bold tracking-tight">
            SR
          </div>
          <div className="space-y-0.5">
            <h1 className="text-base font-semibold tracking-tight">Slim Router</h1>
            <p className="text-xs text-muted-foreground">Vertex AI &amp; Google AI Studio Gateway</p>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Sign in to console</CardTitle>
            <CardDescription>Enter your admin password to manage routing and telemetry.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="admin-pw">Admin password</Label>
                <div className="relative">
                  <Input
                    id="admin-pw"
                    type={showPw ? "text" : "password"}
                    autoFocus
                    required
                    className="pr-9"
                    placeholder="Enter admin password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
                    aria-label={showPw ? "Hide password" : "Show password"}
                  >
                    {showPw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button type="submit" className="w-full" size="lg" disabled={loading}>
                {loading ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center font-mono text-[10px] text-muted-foreground">
          Node 26 · AES-256-GCM Vault · node:sqlite
        </p>
      </div>
    </div>
  );
}

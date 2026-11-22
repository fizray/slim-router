import { useState, useEffect } from "react";
import {
  Activity, Gauge, DollarSign, DatabaseZap, SearchCode, ShieldAlert,
  Cloud, Layers, KeyRound, Settings, LogOut, Menu, X, Sun, Moon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const NAV_SECTIONS = [
  {
    label: "Observability",
    items: [
      { id: "overview", label: "Overview", icon: Activity },
      { id: "performance", label: "Performance", icon: Gauge },
      { id: "cost", label: "Cost & Pricing", icon: DollarSign },
      { id: "cache", label: "Prompt Caching", icon: DatabaseZap },
      { id: "traces", label: "Trace Explorer", icon: SearchCode },
      { id: "reliability", label: "Reliability", icon: ShieldAlert },
    ],
  },
  {
    label: "Gateway",
    items: [
      { id: "providers", label: "Vertex & AI Studio", icon: Cloud },
      { id: "combos", label: "Combos & Aliases", icon: Layers },
      { id: "keys", label: "API Keys & Limits", icon: KeyRound },
      { id: "settings", label: "Settings & Backups", icon: Settings },
    ],
  },
];

export function AppShell({ activePage, onNavigate, onLogout, children }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem("9r_theme");
    return saved ? saved === "dark" : true;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("9r_theme", dark ? "dark" : "light");
  }, [dark]);

  const activeItem = NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.id === activePage);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-xs lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r bg-card/70 backdrop-blur transition-transform duration-200 lg:static lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex h-14 items-center justify-between border-b px-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground text-xs font-bold">
              9R
            </div>
            <div>
              <div className="text-sm font-semibold leading-none tracking-tight">9Router</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">Vertex &amp; AI Studio</div>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {NAV_SECTIONS.map((sec) => (
            <div key={sec.label}>
              <div className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {sec.label}
              </div>
              <div className="space-y-0.5">
                {sec.items.map((item) => {
                  const Icon = item.icon;
                  const active = activePage === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onNavigate(item.id);
                        setMobileOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-xs font-medium transition-colors cursor-pointer",
                        active
                          ? "bg-primary text-primary-foreground shadow-xs"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t px-4 py-3 text-[10px] text-muted-foreground flex items-center justify-between">
          <span>Node 26 · node:sqlite</span>
          <span className="inline-flex items-center gap-1 text-emerald-500 font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Hardened
          </span>
        </div>
      </aside>

      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b bg-background/80 px-4 lg:px-6 backdrop-blur">
          <div className="flex items-center gap-2.5">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)}>
              <Menu className="h-4 w-4" />
            </Button>
            <h1 className="text-sm font-semibold tracking-tight">{activeItem?.label || "Dashboard"}</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={() => setDark((d) => !d)} title="Toggle theme">
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button variant="outline" size="sm" onClick={onLogout}>
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </Button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-6">
          <div className="mx-auto max-w-7xl space-y-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

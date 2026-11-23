import { useState, useEffect } from "react";
import {
  Activity, Gauge, DollarSign, DatabaseZap, SearchCode, ShieldAlert,
  Cloud, Boxes, Layers, KeyRound, Settings, LogOut, Menu, X, Sun, Moon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const NAV_SECTIONS = [
  {
    label: "Observability",
    items: [
      { id: "overview", label: "Overview", icon: Activity },
      { id: "performance", label: "Performance", icon: Gauge },
      { id: "cost", label: "Cost & Rates", icon: DollarSign },
      { id: "cache", label: "Prompt Caching", icon: DatabaseZap },
      { id: "traces", label: "Trace Explorer", icon: SearchCode },
      { id: "reliability", label: "Reliability", icon: ShieldAlert },
    ],
  },
  {
    label: "Gateway",
    items: [
      { id: "models", label: "Models & Probe", icon: Boxes },
      { id: "providers", label: "Vertex & AI Studio", icon: Cloud },
      { id: "combos", label: "Combos & Aliases", icon: Layers },
      { id: "keys", label: "API Keys & Limits", icon: KeyRound },
      { id: "settings", label: "Settings & Pricing", icon: Settings },
    ],
  },
];

const MOBILE_BOTTOM_TABS = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "models", label: "Models", icon: Boxes },
  { id: "traces", label: "Traces", icon: SearchCode },
  { id: "cost", label: "Cost", icon: DollarSign },
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
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background text-foreground">
      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-card/95 backdrop-blur transition-transform duration-200 lg:static lg:w-60 lg:bg-card/70 lg:translate-x-0",
          mobileOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"
        )}
      >
        <div className="flex h-14 items-center justify-between border-b px-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground text-xs font-bold">
              SR
            </div>
            <div>
              <div className="text-sm font-semibold leading-none tracking-tight">Slim Router</div>
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
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 sm:py-2 text-xs font-medium transition-colors touch-manipulation cursor-pointer",
                        active
                          ? "bg-primary text-primary-foreground shadow-xs"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                    >
                      <Icon className="h-4 w-4 sm:h-3.5 sm:w-3.5 shrink-0" />
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
        <header className="flex h-13 sm:h-14 shrink-0 items-center justify-between border-b bg-background/90 px-3.5 sm:px-4 lg:px-6 backdrop-blur">
          <div className="flex items-center gap-2 min-w-0">
            <Button variant="ghost" size="icon" className="lg:hidden shrink-0" onClick={() => setMobileOpen(true)}>
              <Menu className="h-4 w-4" />
            </Button>
            <h1 className="text-sm font-semibold tracking-tight truncate">{activeItem?.label || "Dashboard"}</h1>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="ghost" size="icon" onClick={() => setDark((d) => !d)} title="Toggle theme">
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button variant="outline" size="sm" onClick={onLogout}>
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-3.5 py-4 sm:p-5 lg:p-6 pb-[calc(5rem+env(safe-area-inset-bottom))] lg:pb-6">
          <div className="mx-auto max-w-7xl space-y-5 sm:space-y-6">{children}</div>
        </main>

        {/* Thumb-friendly Mobile Bottom Navigation Bar */}
        <nav
          aria-label="Mobile navigation"
          className="fixed bottom-0 inset-x-0 z-40 grid grid-cols-5 border-t bg-background/95 backdrop-blur pb-[env(safe-area-inset-bottom)] lg:hidden"
        >
          {MOBILE_BOTTOM_TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activePage === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onNavigate(tab.id)}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors touch-manipulation",
                  active ? "text-foreground" : "text-muted-foreground"
                )}
              >
                <Icon className={cn("h-4 w-4", active && "text-primary")} />
                <span>{tab.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium text-muted-foreground touch-manipulation"
          >
            <Menu className="h-4 w-4" />
            <span>More</span>
          </button>
        </nav>
      </div>
    </div>
  );
}

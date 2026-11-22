import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { AppShell } from "@/components/AppShell";
import { LoginPage } from "@/pages/LoginPage";
import { OverviewPage } from "@/pages/OverviewPage";
import { PerformancePage } from "@/pages/PerformancePage";
import { CostPricingPage } from "@/pages/CostPricingPage";
import { CachePage } from "@/pages/CachePage";
import { TracesPage } from "@/pages/TracesPage";
import { ReliabilityPage } from "@/pages/ReliabilityPage";
import { ProvidersPage } from "@/pages/ProvidersPage";
import { CombosPage } from "@/pages/CombosPage";
import { ApiKeysPage } from "@/pages/ApiKeysPage";
import { SettingsPage } from "@/pages/SettingsPage";

const PAGES = {
  overview: OverviewPage,
  performance: PerformancePage,
  cost: CostPricingPage,
  cache: CachePage,
  traces: TracesPage,
  reliability: ReliabilityPage,
  providers: ProvidersPage,
  combos: CombosPage,
  keys: ApiKeysPage,
  settings: SettingsPage,
};

function pageFromLocation() {
  const seg = window.location.pathname.replace(/^\/+|\/+$/g, "").split("/").pop();
  return seg && PAGES[seg] ? seg : "overview";
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [page, setPage] = useState(pageFromLocation);

  useEffect(() => {
    apiFetch("/api/auth/status")
      .then((res) => setAuthed(!!res?.authenticated))
      .catch(() => setAuthed(false))
      .finally(() => setAuthChecked(true));

    const onPop = () => setPage(pageFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function navigate(next) {
    setPage(next);
    window.history.pushState({}, "", next === "overview" ? "/" : `/${next}`);
  }

  async function handleLogout() {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setAuthed(false);
  }

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-xs text-muted-foreground">
        Loading 9Router...
      </div>
    );
  }

  if (!authed) {
    return <LoginPage onSuccess={() => setAuthed(true)} />;
  }

  const ActivePage = PAGES[page] || OverviewPage;

  return (
    <AppShell activePage={page} onNavigate={navigate} onLogout={handleLogout}>
      <ActivePage />
    </AppShell>
  );
}

import { NextResponse } from "next/server";
import { getCostAnalytics, getApiKeys, getSettings } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const range = url.searchParams.get("range") || "30d";
    const [data, keys, settings] = await Promise.all([
      getCostAnalytics({ range }),
      getApiKeys(),
      getSettings(),
    ]);

    const keyMap = Object.fromEntries(keys.map((k) => [k.id, k]));
    const enrichedByApiKey = (data.byApiKey || []).map((row) => ({
      ...row,
      keyName: keyMap[row.apiKeyId]?.name || (row.apiKeyId ? row.apiKeyId.slice(0, 8) : "unknown"),
      keyHint: keyMap[row.apiKeyId]?.keyHint || "",
      dailyBudgetUsd: keyMap[row.apiKeyId]?.dailyBudgetUsd ?? null,
      monthlyBudgetUsd: keyMap[row.apiKeyId]?.monthlyBudgetUsd ?? null,
    }));

    return NextResponse.json({
      ...data,
      byApiKey: enrichedByApiKey,
      globalBudgets: {
        dailyBudgetUsd: settings.globalDailyBudgetUsd ?? null,
        monthlyBudgetUsd: settings.globalMonthlyBudgetUsd ?? null,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to load cost analytics" }, { status: 500 });
  }
}

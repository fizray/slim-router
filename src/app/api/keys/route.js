import { NextResponse } from "next/server";
import { getApiKeys, createApiKey } from "@/lib/db/repos/apiKeysRepo.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const keys = await getApiKeys();
    return NextResponse.json({ keys }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to fetch keys" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const {
      name,
      access,
      rpmLimit,
      tpmLimit,
      dailyBudgetUsd,
      monthlyBudgetUsd,
      expiresAt,
    } = body || {};

    if (!name || !String(name).trim()) {
      return NextResponse.json({ error: "Key name is required" }, { status: 400 });
    }

    const created = await createApiKey(String(name).trim(), {
      access,
      rpmLimit,
      tpmLimit,
      dailyBudgetUsd,
      monthlyBudgetUsd,
      expiresAt,
    });

    // `created.key` is returned ONCE — never stored in plaintext
    return NextResponse.json(created, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to create API key" }, { status: 400 });
  }
}

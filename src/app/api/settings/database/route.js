import { NextResponse } from "next/server";
import { exportDb, importDb } from "@/lib/db/index.js";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";

const PASSWORD_HEADER = "x-9r-password";
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request) {
  try {
    const password = request.headers.get(PASSWORD_HEADER);
    if (!(await verifyDashboardPassword(password))) {
      return NextResponse.json({ error: "Admin password re-authentication required" }, { status: 401, headers: NO_STORE });
    }
    const url = new URL(request.url);
    const includeSecrets = url.searchParams.get("includeSecrets") === "true";
    const payload = await exportDb({ includeSecrets });
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to export database" }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request) {
  try {
    const { password, ...payload } = await request.json();
    if (!(await verifyDashboardPassword(password))) {
      return NextResponse.json({ error: "Admin password re-authentication required" }, { status: 401, headers: NO_STORE });
    }
    await importDb(payload);
    return NextResponse.json({ success: true }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to import database" }, { status: 400, headers: NO_STORE });
  }
}

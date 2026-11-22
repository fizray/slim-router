import { NextResponse } from "next/server";
import { getAuthTokenFromRequest, getDashboardAuthSession } from "@/lib/auth/dashboardSession.js";

export async function GET(request) {
  try {
    const token = getAuthTokenFromRequest(request);
    const session = await getDashboardAuthSession(token);
    return NextResponse.json(
      {
        authenticated: !!session,
        requireLogin: true,
        authMode: "password",
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      { authenticated: false, requireLogin: true, authMode: "password" },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
}

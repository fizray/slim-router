import { NextResponse } from "next/server";
import { buildClearAuthCookieHeader } from "@/lib/auth/dashboardSession.js";

export async function POST() {
  return NextResponse.json(
    { success: true },
    {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": buildClearAuthCookieHeader(),
      },
    }
  );
}

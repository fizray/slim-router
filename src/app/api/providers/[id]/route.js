import { NextResponse } from "next/server";
import {
  getProviderConnectionById,
  updateProviderConnection,
  deleteProviderConnection,
  maskConnectionForApi,
} from "@/lib/db/index.js";
import { assertUpstreamProviderUrl } from "@/shared/utils/ssrfGuard.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await getProviderConnectionById(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    return NextResponse.json({ connection: maskConnectionForApi(connection) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const existing = await getProviderConnectionById(id);
    if (!existing) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    if (body.providerSpecificData?.baseUrl) {
      assertUpstreamProviderUrl(body.providerSpecificData.baseUrl);
    }

    const updateData = {};
    for (const field of ["name", "priority", "globalPriority", "defaultModel", "isActive", "testStatus", "providerSpecificData"]) {
      if (body[field] !== undefined) updateData[field] = body[field];
    }
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      updateData.apiKey = body.apiKey.trim();
    }

    const updated = await updateProviderConnection(id, updateData);
    return NextResponse.json({ connection: maskConnectionForApi(updated) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteProviderConnection(id);
    if (!deleted) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

import { NextResponse } from "next/server";
import { getApiKeyById, updateApiKey, deleteApiKey } from "@/lib/db/repos/apiKeysRepo.js";

export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) return NextResponse.json({ error: "API key not found" }, { status: 404 });
    return NextResponse.json(key, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const updated = await updateApiKey(id, body);
    if (!updated) return NextResponse.json({ error: "API key not found" }, { status: 404 });
    return NextResponse.json(updated, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteApiKey(id);
    if (!deleted) return NextResponse.json({ error: "API key not found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

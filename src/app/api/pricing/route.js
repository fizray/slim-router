import { NextResponse } from "next/server";
import { getPricingDetails, updatePricing, resetPricing, resetAllPricing } from "@/lib/db/repos/pricingRepo.js";
import { syncModelCatalog, getSyncState } from "@/lib/modelCatalog/sync.js";

// GET /api/pricing — returns live synced pricing + user overrides + sync metadata
export async function GET() {
  try {
    const details = await getPricingDetails();
    return NextResponse.json({
      ...details,
      syncState: getSyncState(),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to fetch pricing" }, { status: 500 });
  }
}

// POST /api/pricing — trigger live sync from https://models.dev/api.json right now
export async function POST() {
  try {
    const result = await syncModelCatalog({ force: true });
    const details = await getPricingDetails();
    return NextResponse.json({
      syncResult: result,
      ...details,
      syncState: getSyncState(),
    }, { status: result?.status === "error" ? 502 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to sync pricing" }, { status: 500 });
  }
}

// PATCH /api/pricing — save manual user pricing overrides
export async function PATCH(request) {
  try {
    const body = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid pricing data format" }, { status: 400 });
    }

    const validFields = ["input", "output", "cached", "reasoning", "cache_creation"];
    for (const [provider, models] of Object.entries(body)) {
      if (typeof models !== "object" || models === null) {
        return NextResponse.json({ error: `Invalid pricing for provider: ${provider}` }, { status: 400 });
      }
      for (const [model, pricing] of Object.entries(models)) {
        if (typeof pricing !== "object" || pricing === null) {
          return NextResponse.json({ error: `Invalid pricing for model: ${provider}/${model}` }, { status: 400 });
        }
        for (const [key, value] of Object.entries(pricing)) {
          if (!validFields.includes(key)) {
            return NextResponse.json({ error: `Invalid pricing field: ${key}` }, { status: 400 });
          }
          if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
            return NextResponse.json({ error: `Invalid pricing value for ${key}` }, { status: 400 });
          }
        }
      }
    }

    await updatePricing(body);
    const details = await getPricingDetails();
    return NextResponse.json({ ...details, syncState: getSyncState() });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to update pricing" }, { status: 500 });
  }
}

// DELETE /api/pricing — reset user overrides (falls back to live synced models.dev pricing)
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");

    if (provider && model) await resetPricing(provider, model);
    else if (provider) await resetPricing(provider);
    else await resetAllPricing();

    const details = await getPricingDetails();
    return NextResponse.json({ ...details, syncState: getSyncState() });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to reset pricing" }, { status: 500 });
  }
}

import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { createAtomicBackup, getDbDiskStats } from "@/lib/db/index.js";
import { getDbPaths } from "@/lib/db/paths.js";

export const dynamic = "force-dynamic";

const SAFE_BACKUP_NAME_RE = /^[a-zA-Z0-9._-]+\.sqlite$/;

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const download = url.searchParams.get("download");

    if (download) {
      const base = path.basename(download);
      if (!SAFE_BACKUP_NAME_RE.test(base)) {
        return NextResponse.json({ error: "Invalid backup filename" }, { status: 400 });
      }
      const { backupsDir } = getDbPaths();
      const fullPath = path.join(backupsDir, base);
      if (!fullPath.startsWith(backupsDir) || !fs.existsSync(fullPath)) {
        return NextResponse.json({ error: "Backup file not found" }, { status: 404 });
      }
      const bytes = fs.readFileSync(fullPath);
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "application/x-sqlite3",
          "Content-Disposition": `attachment; filename="${base}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json(getDbDiskStats(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Failed to read backups" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const target = ["config", "telemetry", "payloads"].includes(body?.target) ? body.target : "config";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const result = await createAtomicBackup(target, `${target}-manual-${stamp}.sqlite`);
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error.message || "Backup creation failed" }, { status: 500 });
  }
}

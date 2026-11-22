/**
 * Atomic hot-backup via SQLite `VACUUM INTO` + temp-file rename.
 * - Daily automated backup for config.sqlite (retains last 14 daily snapshots)
 * - On-demand atomic snapshot for config.sqlite or telemetry.sqlite
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getConfigDb, getTelemetryDb, getPayloadsDb } from "./driver.js";
import { getDbPaths, ensureDirs } from "./paths.js";

const MAX_DAILY_BACKUPS = 14;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function formatDateStamp(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sqlQuotePath(filePath) {
  return `'${String(filePath).replace(/'/g, "''")}'`;
}

export async function createAtomicBackup(target = "config", customFilename = null) {
  ensureDirs();
  const { backupsDir } = getDbPaths();
  const db = target === "telemetry"
    ? await getTelemetryDb()
    : target === "payloads"
      ? await getPayloadsDb()
      : await getConfigDb();

  const stamp = formatDateStamp();
  const finalName = customFilename || `${target}-${stamp}.sqlite`;
  const finalPath = path.join(backupsDir, path.basename(finalName));
  const tmpPath = path.join(backupsDir, `.tmp-${target}-${crypto.randomBytes(6).toString("hex")}.sqlite`);

  try {
    db.checkpoint("PASSIVE");
    db.exec(`VACUUM INTO ${sqlQuotePath(tmpPath)}`);
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, finalPath);
    const stat = fs.statSync(finalPath);
    return {
      ok: true,
      target,
      filename: path.basename(finalPath),
      path: finalPath,
      bytes: stat.size,
      createdAt: stat.mtime.toISOString(),
    };
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

export function pruneOldDailyConfigBackups(maxKeep = MAX_DAILY_BACKUPS) {
  const { backupsDir } = getDbPaths();
  if (!fs.existsSync(backupsDir)) return 0;
  const files = fs
    .readdirSync(backupsDir)
    .filter((f) => /^config-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
    .sort()
    .reverse();

  let removed = 0;
  for (const f of files.slice(maxKeep)) {
    try {
      fs.unlinkSync(path.join(backupsDir, f));
      removed++;
    } catch {}
  }
  return removed;
}

export function listBackups() {
  const { backupsDir } = getDbPaths();
  if (!fs.existsSync(backupsDir)) return [];
  return fs
    .readdirSync(backupsDir)
    .filter((f) => f.endsWith(".sqlite") && !f.startsWith(".tmp-"))
    .map((f) => {
      const full = path.join(backupsDir, f);
      const stat = fs.statSync(full);
      return {
        filename: f,
        bytes: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getDbDiskStats() {
  const paths = getDbPaths();
  const statOf = (file) => {
    try {
      const s = fs.statSync(file);
      let walBytes = 0;
      try { walBytes = fs.statSync(`${file}-wal`).size; } catch {}
      return { exists: true, bytes: s.size, walBytes, totalBytes: s.size + walBytes };
    } catch {
      return { exists: false, bytes: 0, walBytes: 0, totalBytes: 0 };
    }
  };
  return {
    config: statOf(paths.configDbFile),
    telemetry: statOf(paths.telemetryDbFile),
    payloads: statOf(paths.payloadsDbFile),
    backups: listBackups(),
  };
}

export function startDailyBackupScheduler() {
  if (globalThis.__9r_backupSchedulerStarted) return;
  globalThis.__9r_backupSchedulerStarted = true;

  const runDaily = async () => {
    try {
      await createAtomicBackup("config");
      pruneOldDailyConfigBackups(MAX_DAILY_BACKUPS);
    } catch (err) {
      console.error("[Backup] Daily config backup failed:", err.message);
    }
  };

  // Run an initial check shortly after boot (skip if today's backup exists)
  const initTimer = setTimeout(() => {
    const { backupsDir } = getDbPaths();
    const todayFile = path.join(backupsDir, `config-${formatDateStamp()}.sqlite`);
    if (!fs.existsSync(todayFile)) {
      runDaily();
    }
  }, 15_000);
  if (typeof initTimer.unref === "function") initTimer.unref();

  const dailyTimer = setInterval(runDaily, ONE_DAY_MS);
  if (typeof dailyTimer.unref === "function") dailyTimer.unref();
}

import path from "node:path";
import fs from "node:fs";
import { getDataDir } from "@/lib/config/env.js";

export function getDbPaths() {
  const dataDir = getDataDir();
  const dbDir = path.join(dataDir, "db");
  const backupsDir = path.join(dataDir, "backups");
  return {
    dataDir,
    dbDir,
    backupsDir,
    configDbFile: path.join(dbDir, "config.sqlite"),
    telemetryDbFile: path.join(dbDir, "telemetry.sqlite"),
    payloadsDbFile: path.join(dbDir, "payloads.sqlite"),
    legacyDataFile: path.join(dbDir, "data.sqlite"),
  };
}

export const DATA_DIR = getDataDir();
export const DB_DIR = path.join(DATA_DIR, "db");
export const BACKUPS_DIR = path.join(DATA_DIR, "backups");
export const CONFIG_DB_FILE = path.join(DB_DIR, "config.sqlite");
export const TELEMETRY_DB_FILE = path.join(DB_DIR, "telemetry.sqlite");
export const PAYLOADS_DB_FILE = path.join(DB_DIR, "payloads.sqlite");
export const DATA_FILE = CONFIG_DB_FILE;

export function ensureDirs() {
  const { dataDir, dbDir, backupsDir } = getDbPaths();
  for (const dir of [dataDir, dbDir, backupsDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
}

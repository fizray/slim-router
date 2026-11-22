/**
 * Unified 3-File Split SQLite Driver using Node 26 LTS built-in `node:sqlite`.
 *
 * All handles live on `globalThis.__9r_db` so Next.js 16 separate bundles
 * (`src/proxy.js` and App Router routes) share identical database instances.
 *
 * CRITICAL: `withNullByteSafeParams` ONLY strips NUL bytes on `typeof p === "string"`.
 * `Buffer` and `Uint8Array` (gzipped BLOBs in payloads.sqlite) pass through untouched.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertRuntimeEnv, isBuildPhase } from "@/lib/config/env.js";
import {
  verifyOrInitVaultCanary,
  encryptConnectionSecrets,
  encryptNodeSecrets,
} from "@/lib/crypto/vault.js";
import { ensureDirs, getDbPaths } from "./paths.js";
import {
  PRAGMA_SQL,
  CONFIG_TABLES,
  TELEMETRY_TABLES,
  PAYLOADS_TABLES,
  SCHEMA_VERSION,
  syncSchemaTables,
} from "./schema.js";
import { stripNullBytes } from "./helpers/nullBytes.js";

const CHECKPOINT_INTERVAL_MS = 60 * 1000;

// Suppress ExperimentalWarning if any Node 22/26 build emits one for node:sqlite
if (!globalThis.__9r_sqliteWarnPatched) {
  const origEmit = process.emit;
  process.emit = function (name, data, ...rest) {
    if (name === "warning" && data?.name === "ExperimentalWarning" && /SQLite/i.test(data.message || "")) {
      return false;
    }
    return origEmit.call(this, name, data, ...rest);
  };
  globalThis.__9r_sqliteWarnPatched = true;
}

function getGlobalDbState() {
  if (!globalThis.__9r_db) {
    globalThis.__9r_db = {
      config: null,
      telemetry: null,
      payloads: null,
      initPromise: null,
      shutdownRegistered: false,
    };
  }
  return globalThis.__9r_db;
}

/**
 * Sanitize ONLY string parameters for SQLite NUL-byte safety.
 * Binary BLOBs (Buffer / Uint8Array) are passed verbatim so gzip streams are never corrupted.
 */
function sanitizeParam(p) {
  if (typeof p === "string") return stripNullBytes(p);
  if (p instanceof Uint8Array || Buffer.isBuffer(p)) return p;
  return p;
}

function createSqliteHandle(filePath, label) {
  const db = new DatabaseSync(filePath);
  db.exec(PRAGMA_SQL);

  const stmtCache = new Map();
  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  const checkpointTimer = setInterval(() => {
    try {
      db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch {
      // ignore busy checkpoint
    }
  }, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer.unref === "function") checkpointTimer.unref();

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(checkpointTimer);
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }

  return {
    driver: "node:sqlite",
    label,
    filePath,
    run(sql, params = []) {
      const clean = Array.isArray(params) ? params.map(sanitizeParam) : [];
      const r = prepare(sql).run(...clean);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    get(sql, params = []) {
      const clean = Array.isArray(params) ? params.map(sanitizeParam) : [];
      return prepare(sql).get(...clean);
    },
    all(sql, params = []) {
      const clean = Array.isArray(params) ? params.map(sanitizeParam) : [];
      return prepare(sql).all(...clean);
    },
    exec(sql) {
      return db.exec(sql);
    },
    transaction(fn) {
      const sp = `sp_${Math.random().toString(36).slice(2, 10)}`;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        const res = fn();
        db.exec(`RELEASE ${sp}`);
        return res;
      } catch (err) {
        try {
          db.exec(`ROLLBACK TO ${sp}`);
          db.exec(`RELEASE ${sp}`);
        } catch {}
        throw err;
      }
    },
    checkpoint(mode = "PASSIVE") {
      try {
        db.exec(`PRAGMA wal_checkpoint(${mode})`);
      } catch {}
    },
    close,
    raw: db,
  };
}

// Consumer OAuth / web scraping providers to skip during legacy migration
const PRUNED_LEGACY_PROVIDERS = new Set([
  "antigravity", "chatgpt-web", "codebuddy-cn", "codebuddy-intl", "codex",
  "commandcode", "cursor", "deepseek-web", "devin-cli", "gemini-cli", "gemini-web",
  "github", "grok-cli", "grok-web", "iflow", "kimchi", "kiro", "mimo-free",
  "minimax-code", "minimax-code-global", "muse-web", "opencode", "opencode-go",
  "opencode-zen", "perplexity-web", "qoder", "qoder-cn", "trae", "uc-web",
  "veoaifree-web", "windsurf", "xiaomi-mimo", "xiaomi-tokenplan", "zed",
]);

function migrateLegacyDataSqlite(configDb, paths) {
  if (!fs.existsSync(paths.legacyDataFile)) return;
  const migratedFlag = configDb.get("SELECT value FROM _meta WHERE key = ?", ["legacy_migrated"]);
  if (migratedFlag?.value) return;

  let legacyDb = null;
  try {
    legacyDb = new DatabaseSync(paths.legacyDataFile, { open: true, readOnly: true });
    const tables = new Set(
      legacyDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    );

    configDb.transaction(() => {
      if (tables.has("providerConnections")) {
        const rows = legacyDb.prepare("SELECT * FROM providerConnections").all();
        for (const r of rows) {
          if (PRUNED_LEGACY_PROVIDERS.has(r.provider)) continue;
          let extra = {};
          try { extra = JSON.parse(r.data || "{}"); } catch {}
          const encrypted = encryptConnectionSecrets(r.id, extra);
          configDb.run(
            `INSERT OR IGNORE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [r.id, r.provider, r.authType || "apikey", r.name, r.email, r.priority, r.isActive ?? 1, JSON.stringify(encrypted), r.createdAt, r.updatedAt]
          );
        }
      }

      if (tables.has("providerNodes")) {
        const rows = legacyDb.prepare("SELECT * FROM providerNodes").all();
        for (const r of rows) {
          let extra = {};
          try { extra = JSON.parse(r.data || "{}"); } catch {}
          const encrypted = encryptNodeSecrets(r.id, extra);
          configDb.run(
            `INSERT OR IGNORE INTO providerNodes(id, type, name, data, createdAt, updatedAt)
             VALUES(?, ?, ?, ?, ?, ?)`,
            [r.id, r.type, r.name, JSON.stringify(encrypted), r.createdAt, r.updatedAt]
          );
        }
      }

      if (tables.has("combos")) {
        const rows = legacyDb.prepare("SELECT * FROM combos").all();
        for (const r of rows) {
          configDb.run(
            `INSERT OR IGNORE INTO combos(id, name, kind, models, createdAt, updatedAt)
             VALUES(?, ?, ?, ?, ?, ?)`,
            [r.id, r.name, r.kind, r.models, r.createdAt, r.updatedAt]
          );
        }
      }

      if (tables.has("kv")) {
        const rows = legacyDb.prepare("SELECT * FROM kv").all();
        for (const r of rows) {
          if (["modelAliases", "customModels", "disabledModels", "pricing"].includes(r.scope)) {
            configDb.run(
              "INSERT OR IGNORE INTO kv(scope, key, value) VALUES(?, ?, ?)",
              [r.scope, r.key, r.value]
            );
          }
        }
      }

      configDb.run(
        "INSERT INTO _meta(key, value) VALUES('legacy_migrated', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [new Date().toISOString()]
      );
    });

    legacyDb.close();
    legacyDb = null;

    const archiveDest = path.join(paths.backupsDir, "legacy-pre-hardening.sqlite");
    if (!fs.existsSync(archiveDest)) {
      fs.renameSync(paths.legacyDataFile, archiveDest);
    }
  } catch (err) {
    console.warn(`[DB] Legacy migration skipped/failed: ${err.message}`);
  } finally {
    try { legacyDb?.close?.(); } catch {}
  }
}

function registerShutdownHooks(state) {
  if (state.shutdownRegistered) return;
  state.shutdownRegistered = true;

  const closeAll = () => {
    try { state.config?.close?.(); } catch {}
    try { state.telemetry?.close?.(); } catch {}
    try { state.payloads?.close?.(); } catch {}
  };

  process.once("beforeExit", closeAll);
  process.once("SIGINT", () => { closeAll(); process.exit(0); });
  process.once("SIGTERM", () => { closeAll(); process.exit(0); });
}

function initAllDatabasesSync() {
  const state = getGlobalDbState();
  if (state.config && state.telemetry && state.payloads) return state;

  if (!isBuildPhase()) {
    assertRuntimeEnv({ exitOnFailure: false });
  }

  ensureDirs();
  const paths = getDbPaths();

  const configDb = createSqliteHandle(paths.configDbFile, "config");
  syncSchemaTables(configDb, CONFIG_TABLES);
  configDb.run(
    "INSERT INTO _meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [String(SCHEMA_VERSION)]
  );

  // Verify or initialize AES-256-GCM Vault Canary on config.sqlite (fail-closed)
  if (!isBuildPhase()) {
    verifyOrInitVaultCanary(configDb);
    migrateLegacyDataSqlite(configDb, paths);
  }

  const telemetryDb = createSqliteHandle(paths.telemetryDbFile, "telemetry");
  syncSchemaTables(telemetryDb, TELEMETRY_TABLES);
  telemetryDb.run(
    "INSERT INTO _meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [String(SCHEMA_VERSION)]
  );

  const payloadsDb = createSqliteHandle(paths.payloadsDbFile, "payloads");
  syncSchemaTables(payloadsDb, PAYLOADS_TABLES);
  payloadsDb.run(
    "INSERT INTO _meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [String(SCHEMA_VERSION)]
  );

  state.config = configDb;
  state.telemetry = telemetryDb;
  state.payloads = payloadsDb;

  registerShutdownHooks(state);
  return state;
}

export async function getDatabases() {
  const state = getGlobalDbState();
  if (state.config && state.telemetry && state.payloads) return state;
  if (!state.initPromise) {
    state.initPromise = Promise.resolve().then(() => initAllDatabasesSync());
  }
  return state.initPromise;
}

export async function getConfigDb() {
  return (await getDatabases()).config;
}

export async function getTelemetryDb() {
  return (await getDatabases()).telemetry;
}

export async function getPayloadsDb() {
  return (await getDatabases()).payloads;
}

// Backward-compatible aliases (default to config.sqlite)
export async function getAdapter() {
  return getConfigDb();
}

export function getAdapterSync() {
  const state = getGlobalDbState();
  if (!state.config) {
    return initAllDatabasesSync().config;
  }
  return state.config;
}

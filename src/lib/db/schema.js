/**
 * Declarative schema for the 3-File Split SQLite architecture:
 *   1. config.sqlite    — auth, encrypted provider secrets, HMAC API keys, combos, kv
 *   2. telemetry.sqlite — request_traces, trace_spans, metrics_hourly, metrics_daily
 *   3. payloads.sqlite  — trace_payloads (gzipped BLOBs + media manifest, forever retention)
 */

export const SCHEMA_VERSION = 3;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 67108864;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

export const CONFIG_TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER NOT NULL DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key_hash: "TEXT UNIQUE NOT NULL",
      key_hint: "TEXT NOT NULL",
      name: "TEXT",
      is_active: "INTEGER NOT NULL DEFAULT 1",
      access_restricted: "INTEGER NOT NULL DEFAULT 0",
      access_allow: "TEXT",
      rpm_limit: "INTEGER",
      tpm_limit: "INTEGER",
      daily_budget_usd: "REAL",
      monthly_budget_usd: "REAL",
      expires_at: "TEXT",
      last_used_at: "TEXT",
      created_at: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ak_key_hash ON apiKeys(key_hash)",
      "CREATE INDEX IF NOT EXISTS idx_ak_active ON apiKeys(is_active)",
    ],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
};

export const TELEMETRY_TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  request_traces: {
    columns: {
      trace_id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      epoch_ms: "INTEGER NOT NULL",
      api_key_id: "TEXT NOT NULL DEFAULT ''",
      client_tag: "TEXT NOT NULL DEFAULT ''",
      session_id: "TEXT NOT NULL DEFAULT ''",
      endpoint: "TEXT NOT NULL",
      source_format: "TEXT NOT NULL DEFAULT ''",
      requested_model: "TEXT NOT NULL DEFAULT ''",
      combo_name: "TEXT NOT NULL DEFAULT ''",
      final_provider: "TEXT NOT NULL DEFAULT ''",
      final_model: "TEXT NOT NULL DEFAULT ''",
      final_connection_id: "TEXT NOT NULL DEFAULT ''",
      is_stream: "INTEGER NOT NULL DEFAULT 0",
      http_status: "INTEGER NOT NULL",
      status: "TEXT NOT NULL",
      error_category: "TEXT NOT NULL DEFAULT ''",
      error_code: "TEXT",
      error_message: "TEXT",
      attempt_count: "INTEGER NOT NULL DEFAULT 1",
      fallback_triggered: "INTEGER NOT NULL DEFAULT 0",
      ttft_ms: "INTEGER",
      total_ms: "INTEGER NOT NULL DEFAULT 0",
      tpot_ms: "REAL",
      output_tps: "REAL",
      translate_ms: "INTEGER NOT NULL DEFAULT 0",
      prompt_tokens: "INTEGER NOT NULL DEFAULT 0",
      uncached_input_tokens: "INTEGER NOT NULL DEFAULT 0",
      cached_read_tokens: "INTEGER NOT NULL DEFAULT 0",
      cache_write_tokens: "INTEGER NOT NULL DEFAULT 0",
      completion_tokens: "INTEGER NOT NULL DEFAULT 0",
      reasoning_tokens: "INTEGER NOT NULL DEFAULT 0",
      total_tokens: "INTEGER NOT NULL DEFAULT 0",
      has_multimodal: "INTEGER NOT NULL DEFAULT 0",
      media_count: "INTEGER NOT NULL DEFAULT 0",
      cost_input: "REAL NOT NULL DEFAULT 0",
      cost_output: "REAL NOT NULL DEFAULT 0",
      cost_reasoning: "REAL NOT NULL DEFAULT 0",
      cost_cache_read: "REAL NOT NULL DEFAULT 0",
      cost_cache_write: "REAL NOT NULL DEFAULT 0",
      cost_total: "REAL NOT NULL DEFAULT 0",
      cost_without_cache: "REAL NOT NULL DEFAULT 0",
      cache_net_savings: "REAL NOT NULL DEFAULT 0",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rt_epoch ON request_traces(epoch_ms DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rt_provider_epoch ON request_traces(final_provider, epoch_ms DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rt_model_epoch ON request_traces(final_model, epoch_ms DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rt_apikey_epoch ON request_traces(api_key_id, epoch_ms DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rt_tag_epoch ON request_traces(client_tag, epoch_ms DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rt_status_epoch ON request_traces(status, epoch_ms DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rt_session_epoch ON request_traces(session_id, epoch_ms DESC)",
    ],
  },
  trace_spans: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      trace_id: "TEXT NOT NULL",
      span_order: "INTEGER NOT NULL",
      span_type: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connection_id: "TEXT",
      target_format: "TEXT",
      started_at_ms: "INTEGER NOT NULL",
      duration_ms: "INTEGER NOT NULL",
      ttft_ms: "INTEGER",
      http_status: "INTEGER",
      status: "TEXT NOT NULL",
      error_category: "TEXT",
      error_message: "TEXT",
      meta_json: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ts_trace ON trace_spans(trace_id, span_order)",
      "CREATE INDEX IF NOT EXISTS idx_ts_provider ON trace_spans(provider, status)",
    ],
  },
  metrics_hourly: {
    columns: {
      bucket_ts: "INTEGER NOT NULL",
      provider: "TEXT NOT NULL DEFAULT ''",
      model: "TEXT NOT NULL DEFAULT ''",
      api_key_id: "TEXT NOT NULL DEFAULT ''",
      client_tag: "TEXT NOT NULL DEFAULT ''",
      endpoint: "TEXT NOT NULL DEFAULT ''",
      requests: "INTEGER NOT NULL DEFAULT 0",
      success_count: "INTEGER NOT NULL DEFAULT 0",
      error_count: "INTEGER NOT NULL DEFAULT 0",
      fallback_count: "INTEGER NOT NULL DEFAULT 0",
      cache_hit_requests: "INTEGER NOT NULL DEFAULT 0",
      prompt_tokens: "INTEGER NOT NULL DEFAULT 0",
      uncached_input_tokens: "INTEGER NOT NULL DEFAULT 0",
      cached_read_tokens: "INTEGER NOT NULL DEFAULT 0",
      cache_write_tokens: "INTEGER NOT NULL DEFAULT 0",
      completion_tokens: "INTEGER NOT NULL DEFAULT 0",
      reasoning_tokens: "INTEGER NOT NULL DEFAULT 0",
      cost_total: "REAL NOT NULL DEFAULT 0",
      cost_without_cache: "REAL NOT NULL DEFAULT 0",
      cache_net_savings: "REAL NOT NULL DEFAULT 0",
      sum_ttft_ms: "INTEGER NOT NULL DEFAULT 0",
      ttft_sample_count: "INTEGER NOT NULL DEFAULT 0",
      sum_total_ms: "INTEGER NOT NULL DEFAULT 0",
      sum_tps: "REAL NOT NULL DEFAULT 0",
      tps_sample_count: "INTEGER NOT NULL DEFAULT 0",
      ttft_histogram_json: "TEXT NOT NULL DEFAULT '{}'",
      latency_histogram_json: "TEXT NOT NULL DEFAULT '{}'",
    },
    primaryKey: "PRIMARY KEY (bucket_ts, provider, model, api_key_id, client_tag, endpoint)",
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_mh_bucket ON metrics_hourly(bucket_ts DESC)",
      "CREATE INDEX IF NOT EXISTS idx_mh_model ON metrics_hourly(model, bucket_ts DESC)",
      "CREATE INDEX IF NOT EXISTS idx_mh_apikey ON metrics_hourly(api_key_id, bucket_ts DESC)",
    ],
  },
  metrics_daily: {
    columns: {
      bucket_ts: "INTEGER NOT NULL",
      provider: "TEXT NOT NULL DEFAULT ''",
      model: "TEXT NOT NULL DEFAULT ''",
      api_key_id: "TEXT NOT NULL DEFAULT ''",
      client_tag: "TEXT NOT NULL DEFAULT ''",
      endpoint: "TEXT NOT NULL DEFAULT ''",
      requests: "INTEGER NOT NULL DEFAULT 0",
      success_count: "INTEGER NOT NULL DEFAULT 0",
      error_count: "INTEGER NOT NULL DEFAULT 0",
      fallback_count: "INTEGER NOT NULL DEFAULT 0",
      cache_hit_requests: "INTEGER NOT NULL DEFAULT 0",
      prompt_tokens: "INTEGER NOT NULL DEFAULT 0",
      uncached_input_tokens: "INTEGER NOT NULL DEFAULT 0",
      cached_read_tokens: "INTEGER NOT NULL DEFAULT 0",
      cache_write_tokens: "INTEGER NOT NULL DEFAULT 0",
      completion_tokens: "INTEGER NOT NULL DEFAULT 0",
      reasoning_tokens: "INTEGER NOT NULL DEFAULT 0",
      cost_total: "REAL NOT NULL DEFAULT 0",
      cost_without_cache: "REAL NOT NULL DEFAULT 0",
      cache_net_savings: "REAL NOT NULL DEFAULT 0",
      sum_ttft_ms: "INTEGER NOT NULL DEFAULT 0",
      ttft_sample_count: "INTEGER NOT NULL DEFAULT 0",
      sum_total_ms: "INTEGER NOT NULL DEFAULT 0",
      sum_tps: "REAL NOT NULL DEFAULT 0",
      tps_sample_count: "INTEGER NOT NULL DEFAULT 0",
      ttft_histogram_json: "TEXT NOT NULL DEFAULT '{}'",
      latency_histogram_json: "TEXT NOT NULL DEFAULT '{}'",
    },
    primaryKey: "PRIMARY KEY (bucket_ts, provider, model, api_key_id, client_tag, endpoint)",
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_md_bucket ON metrics_daily(bucket_ts DESC)",
      "CREATE INDEX IF NOT EXISTS idx_md_model ON metrics_daily(model, bucket_ts DESC)",
      "CREATE INDEX IF NOT EXISTS idx_md_apikey ON metrics_daily(api_key_id, bucket_ts DESC)",
    ],
  },
};

export const PAYLOADS_TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  trace_payloads: {
    columns: {
      trace_id: "TEXT PRIMARY KEY",
      epoch_ms: "INTEGER NOT NULL",
      timestamp: "TEXT NOT NULL",
      encoding: "TEXT NOT NULL DEFAULT 'gzip'",
      client_headers_json: "TEXT",
      client_request_gz: "BLOB",
      upstream_request_gz: "BLOB",
      upstream_response_gz: "BLOB",
      client_response_gz: "BLOB",
      media_manifest_json: "TEXT",
      raw_bytes: "INTEGER NOT NULL DEFAULT 0",
      compressed_bytes: "INTEGER NOT NULL DEFAULT 0",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_tp_epoch ON trace_payloads(epoch_ms DESC)",
    ],
  },
};

export const TABLES = CONFIG_TABLES;

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}

export function syncSchemaTables(adapter, tableDefs) {
  for (const [tableName, def] of Object.entries(tableDefs)) {
    adapter.exec(buildCreateTableSql(tableName, def));
    const existing = new Set(adapter.all(`PRAGMA table_info(${tableName})`).map((r) => r.name));
    for (const [colName, colType] of Object.entries(def.columns)) {
      if (!existing.has(colName)) {
        adapter.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colType}`);
      }
    }
    for (const idxSql of def.indexes || []) {
      adapter.exec(idxSql);
    }
  }
}

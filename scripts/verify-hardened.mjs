/**
 * End-to-End Hardening, Security, Dynamic Pricing, SQLite Split-DB, Multimodal & Pure Node 26 Server Verification Suite.
 * Run with: node --import ./server/loader.js scripts/verify-hardened.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const REPO_ROOT = process.cwd();
const results = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    results.push({ name, ok: true });
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err?.stack || err}`);
    results.push({ name, ok: false, error: err?.message || String(err) });
  }
}

// 1. Dependency Audit (ZERO Next.js, ZERO heavy UI bloat, ONLY 4 runtime prod deps)
await test("1. Dependency audit — Next.js & bloated packages absent, <=4 prod deps", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.optionalDependencies || {}),
    ...(pkg.devDependencies || {}),
  };
  const forbidden = [
    "next",
    "recharts",
    "material-symbols",
    "zustand",
    "prop-types",
    "@dnd-kit/core",
    "marked",
    "@aws-sdk/credential-providers",
    "playwright-core",
    "wreq-js",
    "node-forge",
    "node-machine-id",
    "@node-saml/node-saml",
    "better-sqlite3",
    "sql.js",
    "ws",
    "monaco-editor",
    "@xyflow/react",
    "socks-proxy-agent",
  ];
  for (const dep of forbidden) {
    assert.equal(allDeps[dep], undefined, `Forbidden package still in package.json: ${dep}`);
  }
  assert.ok(Object.keys(pkg.dependencies || {}).length <= 4, "Production runtime deps should be <=4");
});

// 2. Fail-closed startup without secrets
await test("2. Fail-closed runtime boot — exits non-zero without required secrets", async () => {
  const res = spawnSync(process.execPath, ["--import", "./server/loader.js", "server/index.js"], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, NODE_ENV: "production" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.notEqual(res.status, 0, "Expected non-zero exit when secrets are missing");
  assert.match(res.stderr, /Fail-closed startup validation failed/);
});

// Setup isolated temp DATA_DIR
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-verify-"));
const TEST_ENV = {
  JWT_SECRET: crypto.randomBytes(32).toString("hex"),
  API_KEY_SECRET: crypto.randomBytes(32).toString("hex"),
  ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
  ADMIN_PASSWORD: "SuperStrongAdminPassword!2026",
  DATA_DIR: tmpDir,
  TRUSTED_PROXY_IPS: "127.0.0.1,::1",
  SELFHOSTED_HOST_ALLOWLIST: "ollama:11434,192.168.10.50:8000",
  MODEL_CATALOG_SYNC: "off",
  NODE_ENV: "production",
};
Object.assign(process.env, TEST_ENV);

// 3. Vault AES-256-GCM + Startup Canary verification
await test("3. AES-256-GCM Vault Canary & wrong ENCRYPTION_KEY fail-closed", async () => {
  const { getConfigDb } = await import("@/lib/db/driver.js");
  const { verifyOrInitVaultCanary, encryptField, decryptField } = await import("@/lib/crypto/vault.js");

  const configDb = await getConfigDb();
  assert.equal(verifyOrInitVaultCanary(configDb), true);

  const ct = encryptField("sk-secret-value-12345", "providerConnections:c1:apiKey");
  assert.ok(ct.startsWith("enc:v1:"));
  assert.equal(decryptField(ct, "providerConnections:c1:apiKey"), "sk-secret-value-12345");
  assert.throws(() => decryptField(ct, "providerConnections:c2:apiKey"));

  const origKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  try {
    assert.throws(() => verifyOrInitVaultCanary(configDb), /Vault Canary verification failed/);
  } finally {
    process.env.ENCRYPTION_KEY = origKey;
  }
});

// 4. Zero-plaintext secrets, HMAC API keys, & Zero Hardcoded Pricing
await test("4. Encrypted secrets, HMAC API keys & 100% Dynamic DB Pricing (zero hardcoded)", async () => {
  const { createProviderConnection, maskConnectionForApi } = await import("@/lib/db/repos/connectionsRepo.js");
  const { createApiKey, authenticateApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
  const { getPricingForModel, saveSyncedPricing, updatePricing } = await import("@/lib/db/repos/pricingRepo.js");
  const { MODEL_PRICING, PROVIDER_PRICING, PATTERN_PRICING } = await import("open-sse/providers/pricing.js");
  const { getDbPaths } = await import("@/lib/db/paths.js");

  // Confirm ZERO hardcoded pricing tables in code
  assert.equal(Object.keys(MODEL_PRICING).length, 0);
  assert.equal(Object.keys(PROVIDER_PRICING).length, 0);
  assert.equal(PATTERN_PRICING.length, 0);
  assert.equal(await getPricingForModel("vertex", "gemini-2.5-pro"), null, "Unsynced price must be null, never hardcoded");

  // Confirm live synced pricing + user override precedence
  await saveSyncedPricing({ vertex: { "gemini-2.5-pro": { input: 1.25, output: 10, cached: 0.31, cache_creation: 1.25 } } });
  const syncedRate = await getPricingForModel("vertex", "gemini-2.5-pro");
  assert.equal(syncedRate?.input, 1.25);

  await updatePricing({ vertex: { "gemini-2.5-pro": { input: 1.11, output: 9.99, cached: 0.2, cache_creation: 1.11 } } });
  const overrideRate = await getPricingForModel("vertex", "gemini-2.5-pro");
  assert.equal(overrideRate?.input, 1.11);

  // Vertex SA encryption check
  const rawVertexSa = JSON.stringify({
    type: "service_account",
    project_id: "my-gcp-proj",
    client_email: "bot@my-gcp-proj.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nTESTKEYDATA\n-----END PRIVATE KEY-----\n",
  });
  const conn = await createProviderConnection({ provider: "vertex", name: "Vertex Multimodal", apiKey: rawVertexSa });
  const masked = maskConnectionForApi(conn);
  assert.equal(masked.apiKey, undefined);
  assert.equal(masked.apiKeyMasked, "sa:bot@my-gcp-proj.iam.gserviceaccount.com");

  const createdKey = await createApiKey("Verify Key", { rpmLimit: 3, dailyBudgetUsd: 0.01 });
  assert.ok(createdKey.key.startsWith("sk-9r_"));
  assert.equal((await authenticateApiKey(createdKey.key))?.id, createdKey.id);

  const rawDb = new DatabaseSync(getDbPaths().configDbFile, { readOnly: true });
  const rawConnRow = rawDb.prepare("SELECT data FROM providerConnections WHERE id = ?").get(conn.id);
  assert.ok(!rawConnRow.data.includes("TESTKEYDATA"));
  assert.ok(rawConnRow.data.includes("enc:v1:"));
  const rawKeyRow = rawDb.prepare("SELECT * FROM apiKeys WHERE id = ?").get(createdKey.id);
  assert.ok(!JSON.stringify(rawKeyRow).includes(createdKey.key));
  assert.equal(rawKeyRow.key_hash.length, 64);
  rawDb.close();
});

// 5. Two-tier SSRF Guard verification
await test("5. Two-tier SSRF Guard — Tier 1 zero exceptions vs Tier 2 allowlist", async () => {
  const { assertPublicUrl, assertUpstreamProviderUrl, fetchPublicMedia } = await import("@/shared/utils/ssrfGuard.js");
  assert.throws(() => assertPublicUrl("http://169.254.169.254/latest/meta-data"));
  assert.throws(() => assertPublicUrl("http://127.0.0.1:20128/api/health"));
  assert.throws(() => assertPublicUrl("http://[::ffff:127.0.0.1]/"));
  await assert.rejects(() => fetchPublicMedia("http://192.168.10.50:8000/img.png"));

  assert.doesNotThrow(() => assertUpstreamProviderUrl("http://ollama:11434/v1/chat/completions"));
  assert.throws(() => assertUpstreamProviderUrl("http://192.168.10.51:8000/v1/chat/completions"));
  assert.throws(() => assertUpstreamProviderUrl("http://169.254.169.254/latest/meta-data"));
});

// 6. Governance RPM + Atomic In-Flight Budget Pre-Reservation
await test("6. Governance — RPM (429) & concurrent atomic in-flight budget pre-reservation (402)", async () => {
  const { checkAndReserveGovernance, resetGovernanceForTests } = await import("@/sse/services/governance.js");
  resetGovernanceForTests();

  const rpmKey = { id: "k-rpm", rpmLimit: 2 };
  const r1 = await checkAndReserveGovernance(rpmKey, { body: { messages: [] } });
  const r2 = await checkAndReserveGovernance(rpmKey, { body: { messages: [] } });
  const r3 = await checkAndReserveGovernance(rpmKey, { body: { messages: [] } });
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, false);
  assert.equal(r3.status, 429);
  r1.release(); r2.release();

  const budgetKey = { id: "k-budget", dailyBudgetUsd: 0.005 };
  const results10 = await Promise.all(
    Array.from({ length: 10 }, () => checkAndReserveGovernance(budgetKey, { body: { messages: [{ role: "user", content: "hi" }] } }))
  );
  const allowedCount = results10.filter((r) => r.allowed).length;
  const blocked402Count = results10.filter((r) => !r.allowed && r.status === 402).length;
  assert.ok(allowedCount >= 1 && allowedCount <= 3, `Expected <=3 allowed, got ${allowedCount}`);
  assert.equal(allowedCount + blocked402Count, 10);
  results10.forEach((r) => r.release?.(0, 0));
});

// 7. Telemetry Normalization, Non-Streaming TPS=NULL, NOT-NULL Rollup UPSERT, BLOB Gzip & Atomic Backup
await test("7. Telemetry canonical tokens, TPS=NULL non-stream, rollup UPSERT, gzip BLOB & VACUUM INTO backup", async () => {
  const { canonicalizeTokens, recordTraceAndSpans, getCacheAnalytics, getTraceById } = await import("@/lib/db/repos/telemetryRepo.js");
  const { enqueueTracePayload, getTracePayloadById } = await import("@/lib/db/payloadQueue.js");
  const { createAtomicBackup } = await import("@/lib/db/backup.js");
  const { getDbPaths } = await import("@/lib/db/paths.js");

  const norm = canonicalizeTokens({
    promptTokenCount: 5500,
    cachedContentTokenCount: 4000,
    candidatesTokenCount: 200,
  }, "gemini");
  assert.equal(norm.prompt_tokens, 5500);
  assert.equal(norm.cached_read_tokens, 4000);
  assert.equal(norm.uncached_input_tokens, 1500);

  const now = Date.now();
  for (const tid of ["trace-1", "trace-2"]) {
    const rec = await recordTraceAndSpans({
      trace_id: tid,
      epoch_ms: now,
      api_key_id: "k1",
      client_tag: "",
      endpoint: "/v1beta/models/gemini-2.5-pro:generateContent",
      source_format: "gemini",
      requested_model: "vertex/gemini-2.5-pro",
      final_provider: "vertex",
      final_model: "gemini-2.5-pro",
      is_stream: false,
      http_status: 200,
      status: "success",
      ttft_ms: null,
      total_ms: 850,
      ...norm,
      cost_input: 0.002,
      cost_cache_read: 0.001,
      cost_cache_write: 0,
      cost_output: 0.002,
      cost_total: 0.005,
      cost_without_cache: 0.01,
      cache_net_savings: 0.005,
    }, [
      { span_type: "policy", started_at_ms: 0, duration_ms: 2, status: "success", http_status: 200 },
      { span_type: "upstream_attempt", provider: "vertex", model: "gemini-2.5-pro", started_at_ms: 5, duration_ms: 840, status: "success", http_status: 200 },
    ]);
    assert.equal(rec.tpot_ms, null);
    assert.equal(rec.output_tps, null);
  }

  const telRaw = new DatabaseSync(getDbPaths().telemetryDbFile, { readOnly: true });
  const rollupRows = telRaw.prepare("SELECT requests FROM metrics_daily WHERE provider = 'vertex' AND client_tag = ''").all();
  assert.equal(rollupRows.length, 1);
  assert.equal(rollupRows[0].requests, 2);
  telRaw.close();

  const cacheStats = await getCacheAnalytics({ range: "24h" });
  assert.ok(cacheStats.summary.tokenCacheHitRatioPct > 72 && cacheStats.summary.tokenCacheHitRatioPct < 73);
  assert.equal((await getTraceById("trace-1")).spans.length, 2);

  const fakePngBase64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(256)]).toString("base64");
  enqueueTracePayload({
    traceId: "trace-1",
    epochMs: now,
    clientHeaders: { authorization: "Bearer sk-9r_secret1234567890" },
    clientRequest: {
      contents: [
        { role: "user", parts: [{ text: "https://api.example.com?key=AIzaSuperSecretKey1234567890" }, { inlineData: { mimeType: "image/png", data: fakePngBase64 } }] },
      ],
    },
    upstreamRequest: { model: "gemini-2.5-pro" },
    upstreamResponse: { text: "OK" },
    clientResponse: { text: "OK" },
  });

  const storedPayload = await getTracePayloadById("trace-1");
  assert.equal(storedPayload.clientHeaders.authorization, "[REDACTED]");
  assert.equal(storedPayload.mediaManifest.length, 1);
  assert.equal(storedPayload.mediaManifest[0].bytes, 264);
  assert.ok(!JSON.stringify(storedPayload.clientRequest).includes("AIzaSuperSecretKey"));
  assert.ok(!JSON.stringify(storedPayload.clientRequest).includes(fakePngBase64));

  const payRaw = new DatabaseSync(getDbPaths().payloadsDbFile, { readOnly: true });
  const blobRow = payRaw.prepare("SELECT client_request_gz FROM trace_payloads WHERE trace_id = 'trace-1'").get();
  assert.equal(blobRow.client_request_gz[0], 0x1f);
  assert.equal(blobRow.client_request_gz[1], 0x8b);
  assert.ok(zlib.gunzipSync(Buffer.from(blobRow.client_request_gz)).toString("utf8").includes("_media"));
  payRaw.close();

  const bkp = await createAtomicBackup("config", "verify-config.sqlite");
  assert.equal(bkp.ok, true);
  const bkpDb = new DatabaseSync(bkp.path, { readOnly: true });
  assert.equal(bkpDb.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  bkpDb.close();
});

// 8. Live Pure Node 26 Server + Built Vite SPA + Full E2E Security Verification
await test("8. Live Pure Node 26 Server — Vite SPA, 401 no-bypass, CSRF 403, rightmost XFF lockout, login, analytics, backup & restart persistence", async () => {
  const port = 29128;
  const srvDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-live-"));
  const spawnSrv = () =>
    spawn(process.execPath, ["--import", "./server/loader.js", "server/index.js"], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH, ...TEST_ENV, DATA_DIR: srvDataDir, PORT: String(port), HOSTNAME: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

  let child = spawnSrv();
  const waitHealthy = async () => {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  };

  try {
    assert.equal(await waitHealthy(), true, "Server failed to become healthy");

    // Vite SPA served with security headers
    const spa = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(spa.status, 200);
    assert.equal(spa.headers.get("x-frame-options"), "DENY");
    assert.equal(spa.headers.get("x-content-type-options"), "nosniff");
    const html = await spa.text();
    assert.ok(html.includes('<div id="root">'), "Built Vite index.html must be served");

    // Unauth inference & private API -> 401
    const r1 = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "vertex/gemini-2.5-pro", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(r1.status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1beta/models`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/providers`, { headers: { "x-9r-cli-token": "forged" } })).status, 401);

    // Rightmost XFF spoofing brute-force lockout
    let spoofLocked = false;
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `http://127.0.0.1:${port}`,
          "X-Forwarded-For": `1.2.3.${i + 1}, 203.0.113.50`,
        },
        body: JSON.stringify({ password: "wrong-password" }),
      });
      if (res.status === 429) { spoofLocked = true; break; }
    }
    assert.equal(spoofLocked, true);

    // Login -> Analytics -> Key creation -> CSRF 403 -> Atomic backup -> SIGTERM persistence
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ password: TEST_ENV.ADMIN_PASSWORD }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];

    for (const ep of ["overview", "performance", "cost", "cache", "reliability", "traces"]) {
      const r = await fetch(`http://127.0.0.1:${port}/api/analytics/${ep}`, { headers: { Cookie: cookie } });
      assert.equal(r.status, 200, `/api/analytics/${ep} failed`);
    }

    const csrfRes = await fetch(`http://127.0.0.1:${port}/api/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example.com", Cookie: cookie },
      body: JSON.stringify({ name: "CSRF" }),
    });
    assert.equal(csrfRes.status, 403);

    const kRes = await fetch(`http://127.0.0.1:${port}/api/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, Cookie: cookie },
      body: JSON.stringify({ name: "Persisted Key", rpmLimit: 20 }),
    });
    assert.equal(kRes.status, 201);
    const kData = await kRes.json();
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { Authorization: `Bearer ${kData.key}` } })).status, 200);

    const bkpRes = await fetch(`http://127.0.0.1:${port}/api/backups`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, Cookie: cookie },
      body: JSON.stringify({ target: "config" }),
    });
    assert.ok(bkpRes.status === 200 || bkpRes.status === 201);

    // Restart via SIGTERM and confirm DB & session persistence
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    child = spawnSrv();
    assert.equal(await waitHealthy(), true);
    const persisted = await (await fetch(`http://127.0.0.1:${port}/api/keys`, { headers: { Cookie: cookie } })).json();
    assert.equal(persisted.keys.length, 1);
    assert.equal(persisted.keys[0].name, "Persisted Key");
    assert.equal(persisted.keys[0].key, undefined);
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(srvDataDir, { recursive: true, force: true });
  }
});

fs.rmSync(tmpDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);

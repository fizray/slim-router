/**
 * Node 26 ESM Module Resolution Hook.
 * Resolves:
 *   - `@/*`        -> `<repo>/src/*`
 *   - `open-sse/*` -> `<repo>/open-sse/*`
 *   - `next/server`-> `<repo>/server/nextServerShim.js`
 *   - extensionless `.js` and directory `/index.js` imports
 */
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SERVER_DIR, "..");
const NEXT_SERVER_SHIM = pathToFileURL(path.join(SERVER_DIR, "nextServerShim.js")).href;

function resolveFilePath(basePath) {
  const candidates = [basePath, `${basePath}.js`, `${basePath}.mjs`, path.join(basePath, "index.js")];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        return pathToFileURL(c).href;
      }
    } catch {}
  }
  return null;
}

module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") {
      return nextResolve(NEXT_SERVER_SHIM, context);
    }

    if (specifier.startsWith("@/")) {
      const resolved = resolveFilePath(path.join(REPO_ROOT, "src", specifier.slice(2)));
      if (resolved) return nextResolve(resolved, context);
    }

    if (specifier.startsWith("open-sse/")) {
      const resolved = resolveFilePath(path.join(REPO_ROOT, specifier));
      if (resolved) return nextResolve(resolved, context);
    }

    // Handle extensionless relative imports inside our own src/ and open-sse/ (never node_modules CJS)
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file://") &&
      !context.parentURL.includes("/node_modules/")
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const candidate = path.resolve(parentDir, specifier);
      if (!path.extname(candidate)) {
        const resolved = resolveFilePath(candidate);
        if (resolved) return nextResolve(resolved, context);
      }
    }

    return nextResolve(specifier, context);
  },
});

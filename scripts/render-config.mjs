/**
 * Render the untracked wrangler configs from the tracked examples.
 *
 *   node scripts/render-config.mjs        # reads .env, writes each worker config
 *
 * Values come from the environment first (CI uses Actions secrets/vars) and
 * fall back to .env. Nothing here is committed: the rendered files are ignored.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values;
}

const values = { ...loadEnvFile(join(root, ".env")), ...process.env };
values.DASHBOARD_WORKER_NAME ||= "sunpower-monitor-dashboard";
values.INGEST_WORKER_NAME ||= "sunpower-monitor-ingest";
values.D1_DATABASE_NAME ||= "sunpower-monitor";
for (const key of ["DASHBOARD_WORKER_NAME", "INGEST_WORKER_NAME"]) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(values[key])) {
    console.error(`${key} must be a lowercase Worker name of at most 63 letters, digits, or dashes`);
    process.exit(1);
  }
}
const dashboardHost = values.DASHBOARD_HOST?.trim();
values.DASHBOARD_ROUTE = dashboardHost
  ? `routes = [{ pattern = ${JSON.stringify(dashboardHost)}, custom_domain = true }]`
  : "";
const missing = new Set();
const configs = [];

for (const worker of ["ingest", "dashboard"]) {
  const example = join(root, "workers", worker, "wrangler.toml.example");
  const target = join(root, "workers", worker, "wrangler.toml");
  const rendered = readFileSync(example, "utf8").replace(/\{\{([A-Z0-9_]+)\}\}/g, (_all, key) => {
    const value = values[key];
    if (key === "DASHBOARD_ROUTE") return value;
    if (value === undefined || value.length === 0) {
      missing.add(key);
      return `REPLACE_WITH_${key}`;
    }
    return value;
  });
  configs.push([target, rendered]);
}

if (missing.size > 0) {
  console.error(`set these deployment values before deploying: ${[...missing].sort().join(", ")}`);
  process.exitCode = 1;
} else {
  for (const [target, rendered] of configs) {
    writeFileSync(target, rendered);
    console.log(`rendered ${target.replace(`${root}/`, "")}`);
  }
}

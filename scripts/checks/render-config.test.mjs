import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function render(dashboardHost, databaseId = "00000000-0000-0000-0000-000000000000", names = {}) {
  const root = mkdtempSync(join(tmpdir(), "sunpower-config-"));
  try {
    mkdirSync(join(root, "scripts", "install"), { recursive: true });
    copyFileSync(join(source, "scripts/install/render-config.mjs"), join(root, "scripts/install/render-config.mjs"));
    for (const worker of ["ingest", "dashboard"]) {
      mkdirSync(join(root, "workers", worker), { recursive: true });
      copyFileSync(join(source, "workers", worker, "wrangler.toml.example"), join(root, "workers", worker, "wrangler.toml.example"));
    }
    const result = spawnSync(process.execPath, [join(root, "scripts/install/render-config.mjs")], {
      env: {
        ...process.env,
        D1_DATABASE_ID: databaseId,
        ALLOWED_USER_IDS: "123",
        COLLECTOR_ID: "home-pvs",
        DEPLOY_TAG: "test",
        GIT_SHA: "test",
        DASHBOARD_HOST: dashboardHost,
        ...names,
      },
      encoding: "utf8",
    });
    const configPath = join(root, "workers/dashboard/wrangler.toml");
    return { status: result.status, error: result.stderr, config: existsSync(configPath) ? readFileSync(configPath, "utf8") : null };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("dashboard route is absent without a custom domain and present with one", () => {
  const domainFree = render("");
  assert.equal(domainFree.status, 0, domainFree.error);
  assert.match(domainFree.config, /workers_dev = true/);
  assert.doesNotMatch(domainFree.config, /^routes = /m);
  assert.doesNotMatch(domainFree.config, /REPLACE_WITH_DASHBOARD_HOST/);
  assert.match(domainFree.config, /\[triggers\]\s+crons = \["\* \* \* \* \*"\]/);
  assert.doesNotMatch(domainFree.config, /BARK_DEVICE_KEY|ALERTS_ENABLED/);

  const customDomain = render("solar.example.com");
  assert.equal(customDomain.status, 0, customDomain.error);
  assert.match(customDomain.config, /^routes = \[\{ pattern = "solar\.example\.com", custom_domain = true \}\]$/m);
  assert.ok(customDomain.config.indexOf("routes =") < customDomain.config.indexOf("[[d1_databases]]"));
});

test("missing required values fail before writing configs", () => {
  const result = render("", "");
  assert.equal(result.status, 1);
  assert.match(result.error, /D1_DATABASE_ID/);
  assert.equal(result.config, null);
});

test("Worker names can be chosen without changing the templates", () => {
  const custom = render("", undefined, {
    DASHBOARD_WORKER_NAME: "my-solar-dashboard",
    INGEST_WORKER_NAME: "my-solar-ingest",
    D1_DATABASE_NAME: "my-solar",
  });
  assert.equal(custom.status, 0, custom.error);
  assert.match(custom.config, /^name = "my-solar-dashboard"$/m);
  assert.match(custom.config, /^database_name = "my-solar"$/m);

  const invalid = render("", undefined, { DASHBOARD_WORKER_NAME: "bad.name" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.error, /DASHBOARD_WORKER_NAME/);
  assert.equal(invalid.config, null);
});

test("empty optional release variables keep existing deployment names", () => {
  const result = render("solar.example.com", undefined, {
    DASHBOARD_WORKER_NAME: "",
    INGEST_WORKER_NAME: "",
    D1_DATABASE_NAME: "",
  });
  assert.equal(result.status, 0, result.error);
  assert.match(result.config, /^name = "sunpower-monitor-dashboard"$/m);
  assert.match(result.config, /^database_name = "sunpower-monitor"$/m);
  assert.match(result.config, /^database_id = "00000000-0000-0000-0000-000000000000"$/m);
  assert.match(result.config, /^COLLECTOR_ID = "home-pvs"$/m);
  assert.match(result.config, /^ALLOWED_USER_IDS = "123"$/m);
  assert.match(result.config, /^routes = \[\{ pattern = "solar\.example\.com", custom_domain = true \}\]$/m);
});

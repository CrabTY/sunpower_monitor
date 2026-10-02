import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Wrangler's WRANGLER_OUTPUT_FILE_PATH contains newline-delimited deployment JSON.
function deploymentOrigin(text, name, domain = "") {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid Worker name");
  const record = text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line))
    .findLast((entry) => entry.type === "deploy" && entry.version === 1 && entry.worker_name === name);
  if (!record?.version_id || !Array.isArray(record.targets)) throw new Error("No completed deployment found for " + name);
  const pattern = new RegExp(`^https://${name}\\.[a-z0-9-]+\\.workers\\.dev$`);
  const matches = record.targets.filter((target) => typeof target === "string" && (domain
    ? target.split(" ")[0].toLowerCase() === domain.toLowerCase() && target.includes("(custom domain") && !target.includes("production: disabled")
    : pattern.test(target)));
  const origins = [...new Set(matches.map((target) => domain ? "https://" + domain.toLowerCase() : target))];
  if (origins.length !== 1) throw new Error("Could not determine one deployed origin for " + name);
  return origins[0];
}

async function verifyService(origin, service, request = fetch) {
  const response = await request(origin + "/api/v1/version", { signal: AbortSignal.timeout(15000) });
  if (!response.ok || (await response.json()).service !== service) throw new Error("Worker identity check failed at " + origin);
}

if (process.argv[2] === "--check") {
  const name = "demo-solar-dashboard";
  const url = "https://demo-solar-dashboard.example.workers.dev";
  const record = { type: "deploy", version: 1, worker_name: name, version_id: "test-version", targets: [url, "schedule: 47 * * * *", "solar.example.com (custom domain)"] };
  const encode = (value) => JSON.stringify(value) + "\n";
  const text = encode({ type: "version-upload", preview_url: "https://preview.example.workers.dev" }) + encode(record);
  assert.equal(deploymentOrigin(text, name), url);
  assert.equal(deploymentOrigin(text, name, "solar.example.com"), "https://solar.example.com");
  assert.equal(deploymentOrigin(text + encode({ ...record, targets: ["https://demo-solar-dashboard.new-account.workers.dev"] }), name), "https://demo-solar-dashboard.new-account.workers.dev");
  for (const targets of [["https://hash-" + url.slice(8)], [url + "/path"], [url + ".evil.example"], [url, "https://demo-solar-dashboard.other.workers.dev"]]) {
    assert.throws(() => deploymentOrigin(encode({ ...record, targets }), name), /one deployed origin/);
  }
  assert.throws(() => deploymentOrigin(text, "other-worker"), /No completed/);
  assert.throws(() => deploymentOrigin(encode({ ...record, version_id: null }), name), /No completed/);
  assert.throws(() => deploymentOrigin(text, name, "wrong.example.com"), /one deployed origin/);
  assert.throws(() => deploymentOrigin(encode({ ...record, targets: ["solar.example.com (custom domain) [production: disabled]"] }), name, "solar.example.com"), /one deployed origin/);
  await verifyService(url, "sunpower-monitor-dashboard", async () => ({ ok: true, json: async () => ({ service: "sunpower-monitor-dashboard" }) }));
  await assert.rejects(verifyService(url, "sunpower-monitor-dashboard", async () => ({ ok: true, json: async () => ({ service: "sunpower-monitor-ingest" }) })), /identity check/);
  console.log("Worker origin checks passed");
} else {
  try {
    const origin = deploymentOrigin(readFileSync(process.argv[2], "utf8"), process.argv[3], process.argv[5]);
    await verifyService(origin, "sunpower-monitor-" + process.argv[4]);
    console.log(origin);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

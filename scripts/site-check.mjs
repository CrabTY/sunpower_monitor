/* Check static links under both hosting layouts, and the demo network boundary. */
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import vm from "node:vm";

const root = fileURLToPath(new URL("../dist/site/", import.meta.url));
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    result.push(...entry.isDirectory() ? await files(path) : [path]);
  }
  return result;
}
for (const path of (await files(root)).filter(path => path.endsWith(".html"))) {
  const html = await readFile(path, "utf8");
  assert.match(html, /<html lang="en"/, "Website and demo default to English: " + path);
  for (const prefix of ["/", "/sunpower_monitor/"]) {
    const page = new URL(prefix + path.slice(root.length), "https://example.test");
    for (const [, link] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = new URL(link, page);
      if (url.origin !== page.origin) continue;
      assert.ok(url.pathname.startsWith(prefix), "Link escaped project path: " + link);
      const target = join(root, decodeURIComponent(url.pathname.slice(prefix.length)));
      const info = await stat(target);
      if (info.isDirectory()) await stat(join(target, "index.html"));
    }
  }
  if (path.includes("/demo/")) {
    assert.match(html, /connect-src 'none'/);
    assert.ok(html.indexOf('src="demo.js"') < html.indexOf('type="module"'), "Mocks must load before clients");
    assert.match(html, /Simulated data/);
  }
}
const source = await readFile(join(root, "demo/demo.js"), "utf8");
for (const prefix of ["/", "/sunpower_monitor/"]) {
  let nativeRequests = 0, positionRequests = 0;
  const document = { getElementById: () => ({ textContent: "" }) };
  const window = { fetch() { nativeRequests++; throw Error("Native network request"); }, addEventListener() {} };
  const navigator = { geolocation: { getCurrentPosition() { positionRequests++; } } };
  const context = { window, navigator, document, Date, URL, URLSearchParams, Response,
    location: { href: "https://example.test" + prefix + "demo/?scenario=day", search: "?scenario=day" },
    localStorage: { setItem() {}, getItem() { return "day"; } },
  };
  vm.runInNewContext(source, context);
  const live = await (await window.fetch("/api/v1/live")).json();
  assert.ok(live.pv_kw > 1, "Simulated solar did not load");
  const location = await (await window.fetch("/api/v1/location")).json();
  assert.equal(location.latitude, 37.7749);
  assert.equal(location.longitude, -122.4194);
  assert.equal((await window.fetch("/api/v1/location", { method: "PUT" })).status, 405);
  assert.equal((await window.fetch("/api/v1/unknown")).status, 404);
  await assert.rejects(window.fetch("https://example.com/not-an-api"), /disabled/);
  navigator.geolocation.getCurrentPosition(() => assert.fail("Received real location"), () => {});
  assert.equal(nativeRequests, 0);
  assert.equal(positionRequests, 0);
}
const settings = await readFile(join(root, "demo/settings.html"), "utf8");
assert.ok([...settings.matchAll(/<(input|button|select|textarea)\b([^>]*)>/g)].every(([, , attrs]) => /\bdisabled\b/.test(attrs)));
console.log("Static site check passed: root/project paths, synthetic API, denied network/writes/location");

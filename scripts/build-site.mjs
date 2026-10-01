/* Public static site: production UI, existing synthetic fixture, no backend. */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist/site");
const demo = join(output, "demo");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "assets"), { recursive: true });
for (const name of ["index.html", "getting-started.html", "compare.html", "project.html", "introduction.css", "introduction.js"]) {
  await cp(join(root, "site", name), join(output, name));
}
for (const name of await readdir(join(root, "site/assets"))) {
  if (/^(live|history|panels|mobile|ct-partial-coverage|ct-busbar-connection|ct-dual-branch)\.png$/.test(name)) {
    await cp(join(root, "site/assets", name), join(output, "assets", name));
  }
}
await mkdir(demo);

const policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const banner = `<aside class="preview-banner" aria-label="Simulated demo">Simulated data · read-only demo · no device or account connected
 <span id="preview-mode"></span> <a href="./?scenario=day">Day</a> <a href="./?scenario=night">Night</a>
 <a href="./?scenario=idle">Day without output</a> <a href="../index.html">About this project</a></aside>`;
const css = `.preview-banner{position:sticky;top:0;z-index:10;padding:8px 16px;background:#111e2b;color:#ecf4f7;font:14px system-ui;line-height:1.8}.preview-banner a{color:white;display:inline-block;margin-left:12px}`;

for (const name of await readdir(join(root, "web"))) {
  if (!/\.(html|js|css)$/.test(name) || ["check.js", "chart-engine.js"].includes(name)) continue;
  let body = await readFile(join(root, "web", name), "utf8");
  if (name.endsWith(".html")) {
    body = body.replace(/(href|src)="\/(?!\/)/g, '$1="./')
      .replace("</head>", `<meta http-equiv="Content-Security-Policy" content="${policy}"><link rel="stylesheet" href="demo.css"><script src="demo.js"></script></head>`)
      .replace("<body>", "<body>" + banner)
      .replace("Nothing here is simulated", "All readings in this demo are simulated");
    if (name === "settings.html") {
      body = body.replace(/<(input|button|select|textarea)\b/g, "<$1 disabled")
        .replace("</header>", '</header><p class="note">Demo settings are read only. Location is a city-center example; device location and changes are disabled.</p>');
    }
  }
  await writeFile(join(demo, name), body);
}
assert.ok((await readdir(demo)).includes("chart-engine.bundle.js"), "Run npm run build:web before building the site");
const fixture = await readFile(join(root, "scripts/preview-client.js"), "utf8");
await writeFile(join(demo, "demo.js"), `/* Generated demo: synthetic readings and San Francisco city-center coordinates. */
// The fixture's fallback fetch is this blocked function, never native network access.
window.fetch = () => Promise.reject(new Error("Demo network access is disabled"));
Object.defineProperty(navigator, "geolocation", { value: {
  getCurrentPosition(_, failed) { if (failed) failed({ code: 1, message: "Location is disabled in the demo" }); }
} });
` + fixture);
await writeFile(join(demo, "demo.css"), css);
await writeFile(join(output, ".nojekyll"), "");
await writeFile(join(output, "_headers"), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: geolocation=(), camera=(), microphone=()
/demo/*
  Content-Security-Policy: ${policy}; frame-ancestors 'none'
`);
console.log("Static introduction and simulated demo built in dist/site/ (not deployed)");

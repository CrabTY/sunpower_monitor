/* Local-only browser preview of the production pages with simulated API data. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "../web");
const site = resolve(here, "../site");
const port = Number(process.env.PORT || 4173);
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg" };
const banner = `<style>
.preview-banner{position:sticky;top:0;z-index:10;padding:8px 16px;background:#111e2b;color:#ecf4f7;font:14px system-ui}
.preview-banner a{color:white;margin-left:16px}
</style><script src="/__preview.js"></script>`;

const server = createServer(async (request, response) => {
  if (request.method !== "GET") {
    response.writeHead(405).end();
    return;
  }
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === "/introduction") {
    response.writeHead(302, { location: `/introduction/${url.search}` }).end();
    return;
  }
  if (url.pathname === "/introduction/demo/" || url.pathname === "/introduction/demo") {
    response.writeHead(302, { location: `/${url.search}` }).end();
    return;
  }
  const introduction = url.pathname.startsWith("/introduction/");
  const root = introduction ? site : web;
  const name = introduction ? url.pathname.slice("/introduction/".length) || "index.html"
    : url.pathname === "/" ? "index.html"
    : /^\/(history|panels|settings)$/.test(url.pathname) ? url.pathname.slice(1) + ".html"
      : url.pathname.slice(1);
  const file = !introduction && name === "__preview.js" ? resolve(here, "preview-client.js") : resolve(root, name);
  if ((introduction && !/^((index|getting-started|compare|project)\.html|introduction\.(css|js)|assets\/(live|history|panels|mobile|ct-partial-coverage|ct-busbar-connection|ct-dual-branch)\.(png|jpg))$/.test(name)) ||
      (name !== "__preview.js" && !file.startsWith(root + sep))) {
    response.writeHead(404).end();
    return;
  }
  try {
    let body = await readFile(file);
    if (!introduction && extname(file) === ".html") {
      body = body.toString("utf8").replace("</head>", banner + "</head>").replace("<body>",
        '<body><aside class="preview-banner">Simulated data · local review' +
        ' <span id="preview-mode"></span><a href="/?scenario=night">Night</a>' +
        '<a href="/?scenario=day">Day</a><a href="/?scenario=idle">Day without output</a></aside>');
    }
    response.writeHead(200, { "content-type": (mime[extname(file)] || "text/plain") + ([".png", ".jpg"].includes(extname(file)) ? "" : "; charset=utf-8"), "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Simulated dashboard: http://127.0.0.1:${server.address().port}/`);
});

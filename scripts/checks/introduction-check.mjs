/* Static pages, native interactions, comparison selection and preview routes. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import vm from 'node:vm';
const names = ['index.html', 'getting-started.html', 'compare.html', 'project.html'];
const pages = Object.fromEntries(names.map(name => [name, readFileSync(new URL('../../site/' + name, import.meta.url), 'utf8')]));
const guide = readFileSync(new URL('../../docs/ct-calibration.md', import.meta.url), 'utf8');
const assets = new Set(['introduction.css', 'introduction.js']);
for (const [name, page] of Object.entries(pages)) {
  assert.doesNotMatch(page, /chatgpt\.com\/c\//);
  assert.equal((page.match(/<h1\b/g) || []).length, 1, name + ' has one primary heading');
  assert.match(page, /aria-current="page"/);
  assert.match(page, /<html lang="en"/, name + ' defaults to English before scripts run');
  assert.doesNotMatch(page, /<details\b/, 'Content belongs on its page rather than hidden in folds');
  for (const [, target] of page.matchAll(/href="#([^"]+)"/g)) assert.ok(page.includes(`id="${target}"`), name + ': ' + target);
  for (const [, ids] of page.matchAll(/aria-labelledby="([^"]+)"/g)) for (const id of ids.split(' ')) assert.ok(page.includes(`id="${id}"`), name + ': ' + id);
  for (const [, target] of page.matchAll(/href="([^"/:#]+\.html)(?:#[^"]*)?"/g)) assert.ok(names.includes(target), 'Missing page: ' + target);
  for (const [, asset] of page.matchAll(/src="(assets\/[^"]+)"/g)) assets.add(asset);
}
assert.doesNotMatch(pages['index.html'], /id="(setup|compare|architecture|references|calibration|calibration-guide)"/);
assert.match(pages['getting-started.html'], /href="https:\/\/github.com\/CrabTY\/sunpower_monitor\/blob\/main\/docs\/ct-calibration.md"/);
const setupSections = Array.from(pages['getting-started.html'].matchAll(/<section\b[^>]*\bid="([^"]+)"/g), ([, id]) => id);
assert.equal(setupSections.at(-1), 'calibration');
for (const name of ['index.html', 'getting-started.html']) {
  const requirements = pages[name].match(/<dl class="requirements preparation-list">([\s\S]*?)<\/dl>/)[1];
  assert.equal((requirements.match(/<dt>/g) || []).length, 3, 'Only three actual prerequisites');
  for (const term of ['24 小时', 'Cloudflare', 'GitHub']) assert.ok(requirements.includes(term));
}
assert.doesNotMatch(guide, /chatgpt\.com\/c\//);
for (const [, asset] of guide.matchAll(/src="([^"]+)"/g)) {
  assert.ok(readFileSync(new URL('../../docs/' + asset, import.meta.url)).length, 'Guide image: ' + asset);
}
for (const asset of assets) assert.ok(readFileSync(new URL('../../site/' + asset, import.meta.url)).length, asset);
const comparison = pages['compare.html'].match(/class="reference-table solution-table"[\s\S]*?<table>([\s\S]*?)<\/table>/)[1];
const rows = Array.from(comparison.matchAll(/<tr>([\s\S]*?)<\/tr>/g), ([, row]) => row);
assert.equal(rows.length, 10);
assert.doesNotMatch(pages['compare.html'], /<option value="0"/);
const buttons = ['zh-CN', 'en'].map(language => ({ dataset: { language }, setAttribute(name, value) { this[name] = value; }, addEventListener(_, fn) { this.click = fn; } }));
const sections = [80, 600].map(top => ({ top, getBoundingClientRect() { return { top: this.top }; } }));
const nav = { parentElement: { dataset: {} }, scrollLeft: 0, clientWidth: 340, scrollWidth: 340, querySelector: () => null, addEventListener() {} };
const header = { height: 76, getBoundingClientRect() { return { height: this.height }; }, querySelector: () => nav };
const media = { matches: false, addEventListener(_, fn) { this.change = fn; } };
const image = {}, caption = {}, original = {};
const viewer = { open: false, events: {}, querySelector: q => q === 'img' ? image : caption, showModal() { this.open = true; }, close() { this.open = false; this.events.close(); }, addEventListener(name, fn) { this.events[name] = fn; } };
function link(href) {
  return { attrs: { href }, getAttribute(name) { return this.attrs[name]; }, setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; }, addEventListener(_, fn) { this.click = fn; }, focus() { this.focused = true; }, querySelector: () => ({ alt: 'Screenshot' }), closest: () => null };
}
const screenshot = link('assets/live.png');
const internal = link('getting-started.html#first-use');
const external = link('https://github.com/CrabTY/sunpower_monitor');
const option = { dataset: { en: 'Home Assistant', zh: 'Home Assistant' } };
const bodyClasses = new Set();
let language;
const document = {
  documentElement: { dataset: { titleEn: 'PVS6 energy history', titleZh: 'PVS6 的能源历史' }, style: { setProperty() {} }, classList: { add() {}, remove() {} }, get lang() { return language; }, set lang(value) {
    if (language && language !== value) { sections.forEach(s => { s.top += 300; }); header.height = value === 'en' ? 76 : 100; }
    language = value;
  } },
  body: { classList: { add: v => bodyClasses.add(v), remove: v => bodyClasses.delete(v) } },
  querySelectorAll: q => ({ '[data-language]': buttons, 'main > section': sections, '[data-section-link]': [], 'a[data-screenshot]': [screenshot], 'a[href]': [internal, external], '#compare-product option': [option] }[q] || []),
  querySelector: q => q === '.site-header' ? header : null,
  getElementById: id => id === 'image-viewer' ? viewer : original,
};
const window = {
  location: { href: 'http://localhost/introduction/getting-started.html#calibration' },
  history: { replaceState(_, __, url) { window.location.href = String(url); } },
  events: {}, addEventListener(name, fn) { this.events[name] = fn; },
  requestAnimationFrame: fn => fn(), matchMedia: () => media,
  scrollBy({ top }) { sections.forEach(s => { s.top -= top; }); },
};
const context = { document, window, URL };
vm.runInNewContext(readFileSync(new URL('../../site/introduction.js', import.meta.url), 'utf8'), context);
assert.equal(language, 'en', 'A URL without a language defaults to English');
assert.equal(new URL(window.location.href).searchParams.get('lang'), 'en');
assert.equal(new URL(internal.attrs.href).searchParams.get('lang'), 'en');
assert.equal(new URL(internal.attrs.href).hash, '#first-use');
assert.equal(external.attrs.href, 'https://github.com/CrabTY/sunpower_monitor');
const offset = sections[0].top - header.height - 24;
buttons[0].click();
assert.equal(language, 'zh-CN');
assert.equal(document.title, 'SunPower Monitor · PVS6 的能源历史');
assert.equal(new URL(window.location.href).hash, '#calibration');
assert.equal(new URL(internal.attrs.href).searchParams.get('lang'), 'zh');
assert.equal(sections[0].top - header.height - 24, offset, 'Language switch keeps reading position');
screenshot.click({ button: 0, preventDefault() {} });
assert.equal(viewer.open, true);
assert.equal(image.src, 'assets/live.png');
assert.equal(original.href, 'assets/live.png');
viewer.events.click({ target: image });
assert.equal(viewer.open, true);
viewer.events.click({ target: viewer });
assert.equal(viewer.open, false);
assert.equal(screenshot.focused, true);
assert.ok(!bodyClasses.has('image-open'));
screenshot.click({ button: 0, ctrlKey: true, preventDefault() { assert.fail('Modified clicks stay native'); } });
assert.equal(viewer.open, false);
media.matches = true; media.change();
screenshot.click({ button: 0, preventDefault() { assert.fail('Mobile keeps native image links'); } });
assert.equal(viewer.open, false);
assert.ok(!screenshot.attrs['aria-haspopup']);
function cell(contents, span = 1) {
  return { innerHTML: contents, colSpan: span, dataset: {}, cloneNode() { return cell(this.innerHTML, this.colSpan); }, removeAttribute() { this.colSpan = 1; }, querySelector(selector) {
    if (selector === '[data-mobile-en]') {
      const label = this.innerHTML.match(/<span lang="en" data-mobile-en="([^"]+)">([^<]+)<\/span>/);
      if (!label) return null;
      return { dataset: { mobileEn: label[1] }, set textContent(value) { assert.equal(value, label[1]); } };
    }
    return { remove: () => { this.innerHTML = this.innerHTML.replace(/<div class="shared-scope">[\s\S]*?<\/div>/g, ''); } };
  } };
}
for (const row of rows) {
  const cells = Array.from(row.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/g), ([, , attrs, contents]) => cell(contents, Number(attrs.match(/colspan="(\d+)"/)?.[1] || 1)));
  const expanded = context.expandComparisonRow({ cells });
  assert.equal(expanded.length, 5, 'Every merged row expands to five cells');
  assert.ok(expanded.every(c => c.colSpan === 1 && !c.innerHTML.includes('class="shared-scope"')));
  expanded.slice(1).forEach((c, index) => { c.dataset.product = String(index); });
  for (const product of ['1', '2', '3']) {
    context.selectComparisonProduct({ querySelectorAll: () => expanded.slice(1) }, product);
    assert.deepEqual(Array.from(expanded.filter(c => c.dataset.product && !c.hidden), c => c.dataset.product), ['0', product], 'This project stays visible alongside the selected competitor');
  }
}
console.log('introduction interaction checks passed');
if (process.argv.includes('--static')) process.exit(0);
const server = spawn(process.execPath, ['scripts/preview/preview.mjs'], { cwd: new URL('../../', import.meta.url), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
try {
  const [output] = await once(server.stdout, 'data');
  const origin = String(output).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(origin);
  const redirect = await fetch(origin + '/introduction?lang=en', { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/introduction/?lang=en');
  const demoRedirect = await fetch(origin + '/introduction/demo/?scenario=day', { redirect: 'manual' });
  assert.equal(demoRedirect.status, 302);
  assert.equal(demoRedirect.headers.get('location'), '/?scenario=day');
  for (const [name, page] of Object.entries(pages)) {
    const response = await fetch(origin + '/introduction/' + name + '?lang=en');
    assert.equal(response.status, 200, name);
    assert.equal(await response.text(), page);
  }
  for (const asset of assets) {
    const response = await fetch(origin + '/introduction/' + asset);
    assert.equal(response.status, 200, asset);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(new URL('../../site/' + asset, import.meta.url)), asset);
    if (asset.endsWith('.jpg')) assert.equal(response.headers.get('content-type'), 'image/jpeg');
  }
  for (const path of ['/introduction/local-deployment.md', '/introduction/ct-calibration.md', '/introduction/assets/ct-dual-200a.png', '/introduction/__preview.js', '/introduction/assets/../../local-deployment.md']) assert.equal((await fetch(origin + path)).status, 404, path);
  assert.match(await (await fetch(origin + '/')).text(), /<script src="\/__preview.js"><\/script>/);
  console.log('introduction page and route checks passed');
} finally { server.kill(); await once(server, 'exit'); }

const buttons = document.querySelectorAll('[data-language]');
const header = document.querySelector('.site-header');
const readingSections = [...document.querySelectorAll('main > section')];
const imageLinks = document.querySelectorAll('a[data-screenshot]');
const phone = window.matchMedia('(max-width: 520px)');
const navigation = header.querySelector('nav');
const navStrip = navigation.parentElement;

function readingTop() {
  return header.getBoundingClientRect().height + 24;
}
function updateNavEdges() {
  navStrip.dataset.moreStart = String(navigation.scrollLeft > 1);
  navStrip.dataset.moreEnd = String(navigation.scrollLeft + navigation.clientWidth < navigation.scrollWidth - 1);
}
function updateNavigation() {
  const top = readingTop();
  document.documentElement.style.setProperty('--reading-offset', `${top}px`);
  const current = navigation.querySelector('[aria-current]');
  if (current) {
    const item = current.getBoundingClientRect();
    const bounds = navigation.getBoundingClientRect();
    const left = item.left < bounds.left + 16 ? item.left - bounds.left - 16
      : item.right > bounds.right - 16 ? item.right - bounds.right + 16 : 0;
    if (left) navigation.scrollBy({ left, behavior: 'instant' });
  }
  updateNavEdges();
}
function setLanguage(language, preservePosition = false) {
  const anchor = preservePosition && (readingSections.filter(section => section.getBoundingClientRect().top <= readingTop() + 24).at(-1) || readingSections[0]);
  const offset = anchor ? anchor.getBoundingClientRect().top - readingTop() : 0;
  if (anchor) document.documentElement.classList.add('changing-language');
  const selected = language === 'en' ? 'en' : 'zh-CN';
  document.documentElement.lang = selected;
  document.title = 'SunPower Monitor · ' + document.documentElement.dataset[selected === 'en' ? 'titleEn' : 'titleZh'];
  buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.language === selected)));
  const url = new URL(window.location.href);
  url.searchParams.set('lang', selected === 'en' ? 'en' : 'zh');
  window.history.replaceState(null, '', url);
  document.querySelectorAll('a[href]').forEach(link => {
    const destination = new URL(link.getAttribute('href'), url);
    if (destination.origin === url.origin && /\/(index|getting-started|compare|project)\.html$/.test(destination.pathname)) {
      destination.searchParams.set('lang', selected === 'en' ? 'en' : 'zh');
      link.setAttribute('href', destination.href);
    }
  });
  document.querySelectorAll('#compare-product option').forEach(option => {
    option.textContent = selected === 'en' ? option.dataset.en : option.dataset.zh;
  });
  if (anchor) {
    window.requestAnimationFrame(() => {
      window.scrollBy({ top: anchor.getBoundingClientRect().top - readingTop() - offset, behavior: 'instant' });
      updateNavigation();
      document.documentElement.classList.remove('changing-language');
    });
  } else updateNavigation();
}
setLanguage(new URL(window.location.href).searchParams.get('lang'));
buttons.forEach(button => button.addEventListener('click', () => setLanguage(button.dataset.language, true)));
window.addEventListener('popstate', () => setLanguage(new URL(window.location.href).searchParams.get('lang')));

const viewer = document.getElementById('image-viewer');
const viewerImage = viewer.querySelector('img');
const viewerCaption = viewer.querySelector('figcaption');
const originalImage = document.getElementById('image-original');
let imageOpener;
function updateImageLinks() {
  imageLinks.forEach(link => {
    if (phone.matches) link.removeAttribute('aria-haspopup');
    else link.setAttribute('aria-haspopup', 'dialog');
  });
}
updateImageLinks();
phone.addEventListener('change', updateImageLinks);
imageLinks.forEach(link => {
  link.addEventListener('click', event => {
    if (phone.matches || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    viewerImage.src = link.getAttribute('href');
    viewerImage.alt = link.querySelector('img')?.alt || link.innerText.trim();
    viewerCaption.textContent = link.closest('figure')?.querySelector('figcaption')?.innerText || viewerImage.alt;
    originalImage.href = link.getAttribute('href');
    imageOpener = link;
    viewer.showModal();
    document.body.classList.add('image-open');
  });
});
viewer.addEventListener('click', event => {
  if (event.target === viewer) viewer.close();
});
viewer.addEventListener('close', () => {
  document.body.classList.remove('image-open');
  imageOpener?.focus({ preventScroll: true });
});

// Expand shared cells for the phone view; the desktop table remains the source.
function expandComparisonRow(row) {
  return Array.from(row.cells).flatMap(cell => Array.from({ length: cell.colSpan }, () => {
    const copy = cell.cloneNode(true);
    copy.removeAttribute('colspan');
    copy.querySelector('.shared-scope')?.remove();
    const shortLabel = copy.querySelector('[data-mobile-en]');
    if (shortLabel) shortLabel.textContent = shortLabel.dataset.mobileEn;
    return copy;
  }));
}
function selectComparisonProduct(table, product) {
  table.querySelectorAll('[data-product]').forEach(cell => {
    cell.hidden = cell.dataset.product !== '0' && cell.dataset.product !== product;
  });
}
const comparison = document.querySelector('.solution-table table');
if (comparison) {
  const mobileTable = document.querySelector('.mobile-comparison table');
  Array.from(comparison.rows).forEach((row, index) => {
    const copy = document.createElement('tr');
    expandComparisonRow(row).forEach((cell, column) => {
      if (column) cell.dataset.product = String(column - 1);
      copy.append(cell);
    });
    (index === 0 ? mobileTable.createTHead() : mobileTable.tBodies[0] || mobileTable.createTBody()).append(copy);
  });
  const select = document.getElementById('compare-product');
  function selectProduct() {
    selectComparisonProduct(mobileTable, select.value);
  }
  select.addEventListener('change', selectProduct);
  selectProduct();
  document.querySelector('.mobile-comparison').hidden = false;
  document.documentElement.classList.add('has-mobile-comparison');
}
navigation.addEventListener('scroll', updateNavEdges, { passive: true });
window.addEventListener('resize', updateNavigation);
updateNavigation();

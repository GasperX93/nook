#!/usr/bin/env node
/**
 * Build a single static `index.html` from the markdown docs.
 *
 *   node docs/build.mjs
 *
 * Reads every .md file under docs/ (and docs/decisions/), renders to HTML
 * via marked, and stitches them together as one self-contained page with
 * a sidebar nav. No CDN, no runtime fetch — opens fine via file://.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

// ─── Marked config ────────────────────────────────────────────────────────────
marked.setOptions({ gfm: true, breaks: false, headerIds: true, mangle: false })

// Tag headings with explicit ids so we can deep-link to sections from the sidebar.
const renderer = new marked.Renderer()
const slug = s =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
renderer.heading = function (arg, levelArg) {
  // marked v18 passes a token { text, depth, tokens, ... } and `this` is the parser.
  // Older versions passed (text, level). Cover both.
  const token = typeof arg === 'object' && arg !== null ? arg : { text: arg, depth: levelArg }
  const inner = token.tokens && this.parser ? this.parser.parseInline(token.tokens) : token.text
  const id = slug(typeof token.text === 'string' ? token.text : inner.replace(/<[^>]+>/g, ''))
  return `<h${token.depth} id="${id}">${inner}</h${token.depth}>\n`
}
marked.use({ renderer })

// ─── Sources ──────────────────────────────────────────────────────────────────
// Order matters — sidebar follows this list.
const TOPICS = [
  { slug: 'architecture', label: 'Architecture', file: 'architecture.md' },
  { slug: 'stamps', label: 'Stamps', file: 'stamps.md' },
  { slug: 'identity', label: 'Identity', file: 'identity.md' },
  { slug: 'encryption', label: 'Encryption & ACT', file: 'encryption.md' },
  { slug: 'messaging', label: 'Messaging', file: 'messaging.md' },
]

const DECISIONS_DIR = join(__dirname, 'decisions')
const decisionFiles = readdirSync(DECISIONS_DIR)
  .filter(f => f.endsWith('.md'))
  .sort()

const DECISIONS = decisionFiles.map(file => {
  const name = basename(file, '.md')
  // 001-variable-overbuy → "ADR-001: variable overbuy"
  const m = name.match(/^(\d+)-(.+)$/)
  const number = m?.[1] ?? ''
  const titleSlug = m?.[2] ?? name
  const label = `ADR-${number}: ${titleSlug.replace(/-/g, ' ')}`
  return { slug: `adr-${number}`, label, file: join('decisions', file) }
})

// ─── Render each .md to HTML ──────────────────────────────────────────────────
function renderDoc(relPath) {
  const md = readFileSync(join(__dirname, relPath), 'utf-8')
  return marked.parse(md)
}

/**
 * Pull h2 anchor + visible-text pairs from rendered doc HTML so the sidebar
 * can list section sub-items. Skips h1 (the doc title — already represented
 * by the topic-level link) and h3+ (too noisy for navigation).
 */
function extractSubsections(html) {
  const out = []
  const re = /<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g
  let m
  while ((m = re.exec(html)) !== null) {
    const id = m[1]
    // Strip inline HTML tags (links, code, etc.) so the sidebar shows clean text.
    const text = m[2].replace(/<[^>]+>/g, '').trim()
    out.push({ id, text })
  }
  return out
}

const sections = [
  ...TOPICS.map(t => {
    const html = renderDoc(t.file)
    return { ...t, html, subs: extractSubsections(html) }
  }),
  ...DECISIONS.map(d => {
    const html = renderDoc(d.file)
    return { ...d, html, subs: extractSubsections(html) }
  }),
]

// ─── Compose the page ─────────────────────────────────────────────────────────
function renderNavGroup(items) {
  return items
    .map(s => {
      if (s.subs.length === 0) {
        // No sub-items: render as a plain link, no collapsible row.
        return `        <a href="#${s.slug}" data-target="${s.slug}" class="topic standalone">${s.label}</a>`
      }
      const subId = `sub-${s.slug}`
      const subItems = s.subs
        .map(x => `            <li><a href="#${x.id}" data-target="${x.id}">${x.text}</a></li>`)
        .join('\n')
      return [
        `        <div class="topic-group" data-topic="${s.slug}">`,
        `          <div class="topic-row">`,
        `            <button class="topic-toggle" type="button" aria-expanded="false" aria-controls="${subId}" aria-label="Toggle ${s.label} sections">`,
        `              <span class="chevron" aria-hidden="true">▸</span>`,
        `            </button>`,
        `            <a href="#${s.slug}" data-target="${s.slug}" class="topic">${s.label}</a>`,
        `          </div>`,
        `          <ul class="sub-nav" id="${subId}" hidden>`,
        subItems,
        `          </ul>`,
        `        </div>`,
      ].join('\n')
    })
    .join('\n')
}

const topicsWithSubs = sections.slice(0, TOPICS.length)
const decisionsWithSubs = sections.slice(TOPICS.length)

const sidebarLinks =
  '<div class="nav-group-label">Topics</div>\n' +
  renderNavGroup(topicsWithSubs) +
  '\n        <div class="nav-group-label">Decisions</div>\n' +
  renderNavGroup(decisionsWithSubs)

const sectionsHtml = sections
  .map(s => `      <section id="${s.slug}" class="doc">\n${s.html}\n      </section>`)
  .join('\n\n')

// Read the project version + date so the page footer is honest.
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'))
const generated = new Date().toISOString().slice(0, 10)

// ─── Static CSS / JS (defined before page template so identifiers exist) ──────
function _css() {
  return `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --bg-surface: #f7f7f8;
  --bg-code: #f3f3f4;
  --fg: #111418;
  --fg-muted: #5b6470;
  --border: #e3e6ea;
  --accent: #f76808;
  --link: #1d4ed8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0d10;
    --bg-surface: #14161a;
    --bg-code: #16181d;
    --fg: #e8eaee;
    --fg-muted: #8b95a3;
    --border: #20232a;
    --accent: #f78030;
    --link: #7da2ff;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
body {
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
}
.skip {
  position: absolute; left: -9999px;
  padding: 8px 12px; background: var(--accent); color: #fff;
}
.skip:focus { left: 8px; top: 8px; z-index: 100; }
.topbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 18px;
  background: var(--bg); border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: baseline; gap: 12px; }
.brand strong { font-size: 15px; letter-spacing: 0.04em; text-transform: uppercase; }
.brand .version { color: var(--fg-muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.brand .generated { color: var(--fg-muted); font-size: 12px; }
.nav-toggle {
  display: none;
  background: transparent; border: 1px solid var(--border); border-radius: 6px;
  padding: 4px 10px; font-size: 16px; color: var(--fg); cursor: pointer;
}
.layout { display: grid; grid-template-columns: 240px 1fr; min-height: calc(100vh - 49px); }
.sidebar {
  border-right: 1px solid var(--border);
  background: var(--bg-surface);
  position: sticky; top: 49px;
  align-self: start;
  max-height: calc(100vh - 49px);
  overflow: auto;
}
.nav-inner { padding: 18px 14px; display: flex; flex-direction: column; gap: 4px; }
.nav-group-label {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--fg-muted); margin-top: 16px; margin-bottom: 4px;
}
.nav-group-label:first-child { margin-top: 0; }
.sidebar a {
  display: block; padding: 6px 10px; border-radius: 6px;
  color: var(--fg); text-decoration: none; font-size: 14px;
}
.sidebar a.topic { font-weight: 600; flex: 1; }
.sidebar a.standalone { display: block; }
.sidebar a:hover { background: rgba(127,127,127,0.08); }
.sidebar a.active {
  background: rgba(247, 104, 8, 0.10);
  color: var(--accent); font-weight: 600;
}

/* Collapsible topic group */
.topic-group { display: flex; flex-direction: column; }
.topic-row {
  display: flex; align-items: center; gap: 2px;
}
.topic-toggle {
  background: transparent; border: 0; padding: 0;
  width: 22px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; color: var(--fg-muted);
  border-radius: 4px;
}
.topic-toggle:hover { background: rgba(127,127,127,0.08); color: var(--fg); }
.topic-toggle .chevron {
  display: inline-block;
  font-size: 11px;
  transition: transform 120ms ease;
  transform: rotate(0deg);
}
.topic-toggle[aria-expanded="true"] .chevron { transform: rotate(90deg); }

.sub-nav {
  list-style: none; margin: 2px 0 6px; padding: 0 0 0 14px;
  margin-left: 22px;
  border-left: 1px solid var(--border);
}
.sub-nav[hidden] { display: none; }
.sub-nav li { margin: 0; }
.sub-nav a {
  font-size: 13px; padding: 4px 8px; color: var(--fg-muted);
}
.sub-nav a:hover { color: var(--fg); }
.sub-nav a.active {
  background: rgba(247, 104, 8, 0.08);
  color: var(--accent);
}
.main { padding: 24px 36px 80px; max-width: 920px; }
@media (max-width: 900px) {
  .nav-toggle { display: inline-block; }
  .layout { grid-template-columns: 1fr; }
  .sidebar { display: none; position: fixed; top: 49px; left: 0; right: 0; max-height: 60vh; z-index: 5; }
  .sidebar.open { display: block; }
  .main { padding: 16px 18px 80px; }
}

.doc { padding-top: 8px; padding-bottom: 32px; border-bottom: 1px dashed var(--border); }
.doc:last-of-type { border-bottom: 0; }
h1, h2, h3, h4, h5 {
  color: var(--fg); line-height: 1.25; font-weight: 700;
  margin: 1.6em 0 0.5em;
}
h1 { font-size: 2em; border-bottom: 1px solid var(--border); padding-bottom: 0.3em; margin-top: 0.4em; }
h2 { font-size: 1.45em; margin-top: 2em; }
h3 { font-size: 1.15em; }
h4 { font-size: 1em; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; }
p { margin: 0.8em 0; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { padding-left: 1.4em; }
li { margin: 0.25em 0; }
blockquote {
  margin: 1em 0; padding: 8px 16px;
  border-left: 3px solid var(--accent);
  background: var(--bg-surface);
  color: var(--fg-muted);
  border-radius: 0 6px 6px 0;
}
blockquote p { margin: 0.3em 0; }
code, kbd, pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.9em;
}
:not(pre) > code {
  background: var(--bg-code); padding: 2px 6px; border-radius: 4px;
  border: 1px solid var(--border);
}
pre {
  background: var(--bg-code); border: 1px solid var(--border);
  padding: 14px 16px; border-radius: 8px;
  overflow-x: auto; line-height: 1.5;
}
pre code { background: none; padding: 0; border: 0; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2.4em 0; }
table {
  border-collapse: collapse; margin: 1em 0;
  display: block; overflow-x: auto; white-space: nowrap;
}
@media (min-width: 640px) {
  table { display: table; white-space: normal; width: 100%; }
}
th, td {
  border: 1px solid var(--border);
  padding: 7px 12px; text-align: left;
  font-size: 0.95em;
}
th { background: var(--bg-surface); font-weight: 600; }
tr:nth-child(even) td { background: rgba(127,127,127,0.03); }

.docfoot { margin-top: 60px; padding-top: 24px; border-top: 1px solid var(--border); color: var(--fg-muted); font-size: 13px; }
`
}

function _script() {
  return `
(function () {
  var sidebar = document.getElementById('sidebar');
  var toggle = document.getElementById('nav-toggle');
  var links = sidebar.querySelectorAll('a[data-target]');
  var sections = Array.prototype.map.call(links, function (l) {
    return { link: l, el: document.getElementById(l.dataset.target) };
  });

  toggle && toggle.addEventListener('click', function () {
    sidebar.classList.toggle('open');
  });

  // Close sidebar on link click in mobile mode.
  links.forEach(function (l) {
    l.addEventListener('click', function () { sidebar.classList.remove('open'); });
  });

  // Collapsible topic groups — toggle button shows/hides the sub-nav.
  function setExpanded(toggleBtn, expanded) {
    toggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    var subId = toggleBtn.getAttribute('aria-controls');
    var sub = subId && document.getElementById(subId);
    if (sub) {
      if (expanded) sub.removeAttribute('hidden');
      else sub.setAttribute('hidden', '');
    }
  }
  var toggles = sidebar.querySelectorAll('.topic-toggle');
  toggles.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var expanded = btn.getAttribute('aria-expanded') === 'true';
      setExpanded(btn, !expanded);
    });
  });

  // Auto-expand the group whose topic-level link becomes active.
  function expandActiveGroup(activeLink) {
    if (!activeLink) return;
    var group = activeLink.closest('.topic-group');
    if (!group) {
      // Active item is a sub-nav link — find its parent group.
      var li = activeLink.closest('.sub-nav');
      if (li) {
        var subId = li.id;
        var ownerToggle = sidebar.querySelector('.topic-toggle[aria-controls="' + subId + '"]');
        if (ownerToggle && ownerToggle.getAttribute('aria-expanded') !== 'true') {
          setExpanded(ownerToggle, true);
        }
      }
      return;
    }
    var t = group.querySelector('.topic-toggle');
    if (t && t.getAttribute('aria-expanded') !== 'true') setExpanded(t, true);
  }

  // Active section highlighting based on scroll position.
  function updateActive() {
    var top = window.scrollY + 90;
    var current = sections[0];
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i];
      var el = s.el;
      if (!el) continue;
      var y = 0, node = el;
      while (node) { y += node.offsetTop || 0; node = node.offsetParent; }
      if (y <= top) current = s;
    }
    sections.forEach(function (s) { s.link.classList.toggle('active', s === current); });
    expandActiveGroup(current ? current.link : null);
  }
  window.addEventListener('scroll', updateActive, { passive: true });
  updateActive();
})();
`
}

const CSS = _css()
const SCRIPT = _script()

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Nook docs — v${pkg.version}</title>
  <style>${CSS}</style>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="topbar">
    <div class="brand">
      <strong>Nook</strong>
      <span class="version">v${pkg.version}</span>
      <span class="generated">docs generated ${generated}</span>
    </div>
    <button class="nav-toggle" id="nav-toggle" aria-label="Toggle navigation">☰</button>
  </header>
  <div class="layout">
    <nav class="sidebar" id="sidebar" aria-label="Sections">
      <div class="nav-inner">
        ${sidebarLinks}
      </div>
    </nav>
    <main id="main" class="main">
${sectionsHtml}
      <footer class="docfoot">
        <p>Source: <code>docs/</code> in the Nook repo. Regenerate with <code>node docs/build.mjs</code>.</p>
      </footer>
    </main>
  </div>
  <script>${SCRIPT}</script>
</body>
</html>
`

// ─── Write ────────────────────────────────────────────────────────────────────
const outPath = join(__dirname, 'index.html')
writeFileSync(outPath, html)
console.log('wrote ' + outPath + ' (' + sections.length + ' sections, ' + html.length + ' bytes)')

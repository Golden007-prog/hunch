import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { cleanupDir } from "./fixtures.js";

// Gaps left by static-site-links.test.ts (which checks href/src targets exist):
// html lang/dir per locale, locale section-id parity, fragment anchors, CSS url()
// and sitemap targets, that every script parses and evaluates without console
// errors in a minimal DOM shim, and the homepage helicoid palette (con_009f720549).
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_ROOT = join(PROJECT_ROOT, "site");
const LOCALES = ["ar", "es", "he", "ru"] as const;
const RTL = new Set(["ar", "he"]);
const ORIGINS = ["https://hunch.local", "https://www.hunchmemory.com", "https://hunchmemory.com"];

function filesBelow(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
const siteRel = (file: string) => relative(SITE_ROOT, file).replaceAll("\\", "/");
const pages = filesBelow(SITE_ROOT).filter((file) => file.endsWith(".html"));
const read = (file: string) => readFileSync(file, "utf8");
const stripCode = (html: string) => html
  .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, "$1$2")
  .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, "$1$2")
  .replace(/<!--[\s\S]*?-->/g, "");
const idsOf = (html: string) => new Set([...stripCode(html).matchAll(/\sid\s*=\s*(["'])(.*?)\1/gi)].map((m) => m[2]!));
const localeOf = (rel: string) => (LOCALES as readonly string[]).find((l) => rel.startsWith(`${l}/`)) ?? "en";

/** Resolve a site route to its page file the way the static host serves it. */
function pageFor(pathname: string): string | undefined {
  const route = decodeURIComponent(pathname).replace(/^\/+/, "").replace(/\/+$/, "");
  const candidates = route
    ? [join(SITE_ROOT, route), join(SITE_ROOT, `${route}.html`), join(SITE_ROOT, route, "index.html")]
    : [join(SITE_ROOT, "index.html")];
  return candidates.find((candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } });
}

test("every page declares its locale's lang, and only he/ar pages are rtl", () => {
  assert.ok(pages.length >= 30);
  const wrong: string[] = [];
  for (const page of pages) {
    const rel = siteRel(page);
    const tag = /<html\b[^>]*>/i.exec(read(page))?.[0] ?? "";
    const lang = /\blang\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const dir = /\bdir\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "ltr";
    const locale = localeOf(rel);
    if (lang !== locale) wrong.push(`${rel}: lang=${lang} expected ${locale}`);
    if (dir !== (RTL.has(locale) ? "rtl" : "ltr")) wrong.push(`${rel}: dir=${dir}`);
  }
  assert.deepEqual(wrong, []);
});

test("every locale ships the same pages as each other, each with an English counterpart and identical section ids", () => {
  const byLocale = new Map<string, string[]>();
  for (const page of pages) {
    const rel = siteRel(page);
    const locale = localeOf(rel);
    if (locale !== "en") byLocale.set(locale, [...(byLocale.get(locale) ?? []), rel.slice(locale.length + 1)].sort());
  }
  const reference = byLocale.get("he") ?? [];
  assert.ok(reference.length >= 4);
  const problems: string[] = [];
  for (const locale of LOCALES) {
    assert.deepEqual(byLocale.get(locale), reference, `${locale} page set differs from he`);
    for (const rel of reference) {
      const english = join(SITE_ROOT, rel);
      let englishIds: Set<string>;
      try { englishIds = idsOf(read(english)); } catch { problems.push(`${locale}/${rel}: no English counterpart`); continue; }
      const localeIds = idsOf(read(join(SITE_ROOT, locale, rel)));
      const missing = [...englishIds].filter((id) => !localeIds.has(id));
      const extra = [...localeIds].filter((id) => !englishIds.has(id));
      if (missing.length || extra.length) problems.push(`${locale}/${rel}: missing [${missing}] extra [${extra}]`);
    }
  }
  assert.deepEqual(problems, []);
});

test("in-page and cross-page fragment links land on an existing id", () => {
  const missing: string[] = [];
  let fragments = 0;
  for (const page of pages) {
    const base = new URL(`/${siteRel(page)}`, ORIGINS[0]);
    for (const match of stripCode(read(page)).matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)) {
      const href = match[2]!;
      if (!href.includes("#") || href === "#") continue;
      let target: URL;
      try { target = new URL(href, base); } catch { continue; }
      if (!ORIGINS.includes(target.origin) || !target.hash) continue;
      const file = pageFor(target.pathname);
      if (!file?.endsWith(".html")) continue; // missing routes are static-site-links' job
      fragments += 1;
      if (!idsOf(read(file)).has(decodeURIComponent(target.hash.slice(1)))) missing.push(`${siteRel(page)} -> ${href}`);
    }
  }
  assert.ok(fragments > 0, "the site should exercise fragment links");
  assert.deepEqual(missing, []);
});

test("stylesheet url() references and sitemap locations resolve to site files", () => {
  const missing: string[] = [];
  for (const css of filesBelow(SITE_ROOT).filter((file) => file.endsWith(".css"))) {
    const base = new URL(`/${siteRel(css)}`, ORIGINS[0]);
    for (const match of read(css).matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) {
      const ref = match[2]!;
      if (/^(?:data:|#)/i.test(ref)) continue;
      const target = new URL(ref, base);
      if (target.origin === ORIGINS[0] && !pageFor(target.pathname)) missing.push(`${siteRel(css)} -> ${ref}`);
    }
  }
  const locs = [...read(join(SITE_ROOT, "sitemap.xml")).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!);
  assert.ok(locs.length >= 5, "sitemap should list the site's pages");
  for (const loc of locs) {
    const target = new URL(loc);
    assert.ok(ORIGINS.includes(target.origin), `sitemap entry on a foreign origin: ${loc}`);
    if (!pageFor(target.pathname)) missing.push(`sitemap.xml -> ${loc}`);
  }
  assert.deepEqual(missing, []);
});

const scripts = filesBelow(SITE_ROOT).filter((file) => file.endsWith(".js"));
const isModule = (source: string) => /^\s*(?:import|export)\s/m.test(source.replace(/`[\s\S]*?`/g, "``"));

test("every site script parses (node --check, module or classic as served)", () => {
  assert.ok(scripts.length >= 7);
  const dir = mkdtempSync(join(tmpdir(), "hunch-site-check-"));
  try {
    for (const script of scripts) {
      const copy = join(dir, siteRel(script).replaceAll("/", "__") + (isModule(read(script)) ? ".mjs" : ".cjs"));
      copyFileSync(script, copy);
      const run = spawnSync(process.execPath, ["--check", copy], { encoding: "utf8", windowsHide: true });
      assert.equal(run.status, 0, `${siteRel(script)} failed to parse:\n${run.stderr}`);
    }
  } finally {
    cleanupDir(dir);
  }
});

/** A permissive DOM: every lookup returns a callable, constructible stand-in that
 * coerces to 0/"" — enough for top-level wiring to run without a browser. */
function permissive(): unknown {
  const target = function () { /* stand-in */ };
  const proxy: unknown = new Proxy(target, {
    get(_t, key) {
      if (key === Symbol.toPrimitive) return (hint: string) => (hint === "number" ? 0 : "");
      if (key === Symbol.iterator) return function* () { /* empty */ };
      if (key === "then") return undefined;
      if (key === "length") return 0;
      return proxy;
    },
    set: () => true,
    apply: () => proxy,
    construct: () => proxy as object,
    has: () => true,
  });
  return proxy;
}

function runInShim(source: string, file: string, extra: Record<string, unknown> = {}, dom: Record<string, unknown> = {}): { errors: string[]; context: vm.Context } {
  const errors: string[] = [];
  const any = permissive();
  const record = (level: string) => (...args: unknown[]) => errors.push(`${level}: ${args.map(String).join(" ")}`);
  const document = {
    documentElement: { dir: "ltr", lang: "en", classes: [] as string[], classList: { add(...names: string[]) { document.documentElement.classes.push(...names); }, remove() {}, toggle() {} }, style: {} },
    body: any, head: any,
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    createElement: () => any, addEventListener() {}, removeEventListener() {}, hidden: false,
    ...dom,
  };
  const window: Record<string, unknown> = {
    document, console: { log() {}, info() {}, debug() {}, warn: record("warn"), error: record("error") },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setTimeout: () => 0, clearTimeout() {}, fetch: () => new Promise(() => { /* never settles */ }),
    location: { pathname: "/", search: "", hash: "", href: "https://hunch.local/" },
    navigator: { language: "en" }, localStorage: { getItem: () => null, setItem() {} },
    IntersectionObserver: any, ResizeObserver: any, MutationObserver: any,
    innerWidth: 1280, innerHeight: 800, scrollY: 0, devicePixelRatio: 1,
    ...extra,
  };
  window.window = window;
  window.self = window;
  window.globalThis = window;
  const context = vm.createContext(window);
  try { new vm.Script(source, { filename: file }).runInContext(context); } catch (error) { errors.push(`throw: ${String(error)}`); }
  return { errors, context };
}

test("classic site scripts evaluate in a minimal DOM shim with no console errors", () => {
  for (const script of scripts) {
    const source = read(script);
    if (isModule(source)) continue;
    assert.deepEqual(runInShim(source, siteRel(script)).errors, [], `${siteRel(script)} (empty page)`);
    // Every selector hits: the script's full wiring path runs against stand-in elements.
    const element = permissive();
    const dom = { querySelector: () => element, querySelectorAll: () => [element, element], getElementById: () => element };
    assert.deepEqual(runInShim(source, siteRel(script), {}, dom).errors, [], `${siteRel(script)} (populated page)`);
  }
});

test("blog data globals load and every locale translates the same UI keys", () => {
  const { context, errors } = runInShim(read(join(SITE_ROOT, "blog", "i18n.js")) + "\n" + read(join(SITE_ROOT, "blog", "posts.js")), "blog");
  assert.deepEqual(errors, []);
  const i18n = context.BLOG_I18N as Record<string, { ui?: Record<string, unknown>; dateLocale?: string }>;
  const posts = context.POSTS as Array<{ slug: string }>;
  assert.ok(Array.isArray(posts) && posts.length > 0);
  const slugs = posts.map((post) => post.slug);
  assert.equal(new Set(slugs).size, slugs.length, "post slugs must be unique");
  for (const locale of LOCALES) {
    assert.ok(i18n[locale], `BLOG_I18N lacks ${locale}`);
    assert.ok(i18n[locale]!.dateLocale, `${locale} lacks dateLocale`);
    assert.deepEqual(Object.keys(i18n[locale]!.ui ?? {}).sort(), Object.keys(i18n.he!.ui ?? {}).sort(), `${locale} UI keys differ from he`);
  }
});

const DNA = join(SITE_ROOT, "dna-hero.js");

test("dna-hero.js wires up without errors when the hero is absent, and with a stub renderer when present", () => {
  const source = read(DNA);
  const importLine = /^import \* as THREE from "[^"]+";\s*$/m;
  assert.match(source, importLine, "dna-hero.js should import three.js as its only dependency");
  const body = source.replace(importLine, "");
  // No hero on the page: the module must stay inert.
  assert.deepEqual(runInShim(body, "dna-hero.js", { THREE: permissive() }).errors, []);
  // Hero present: the renderer (stubbed) must initialise without the fallback warning.
  const element = permissive();
  const run = runInShim(body, "dna-hero.js", { THREE: permissive() }, { getElementById: () => element, querySelector: () => element });
  assert.deepEqual(run.errors, []);
  const root = (run.context.document as { documentElement: { classes: string[] } }).documentElement;
  assert.ok(root.classes.includes("dna-webgl"), "the WebGL path must actually have initialised");
});

test("helicoid palette stays in the green Hunch family, never blue-violet (con_009f720549)", () => {
  const source = read(DNA);
  const rgb: Array<[string, number, number, number]> = [];
  for (const m of source.matchAll(/(?:0x|#)([0-9a-f]{6})\b/gi)) {
    const n = parseInt(m[1]!, 16);
    rgb.push([m[0], n >> 16, (n >> 8) & 255, n & 255]);
  }
  for (const m of source.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)) rgb.push([m[0], +m[1]!, +m[2]!, +m[3]!]);
  // Shader vec3 literals are colors only on color-writing lines; others are directions.
  for (const line of source.split("\n").filter((l) => /Color|Light\s*\+=/.test(l))) {
    for (const m of line.matchAll(/vec[34]\(\s*(?:vec3\()?\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*[,)]/g)) {
      if ([m[1], m[2], m[3]].every((v) => Number(v) <= 1)) rgb.push([m[0], +m[1]! * 255, +m[2]! * 255, +m[3]! * 255]);
    }
  }
  assert.ok(rgb.length >= 15, "palette extraction should find the helicoid colors");
  const offPalette: string[] = [];
  let chromatic = 0;
  for (const [literal, r, g, b] of rgb) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min < 12) continue; // neutral greys/white/black carry no hue
    chromatic += 1;
    const d = max - min;
    const hue = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    const h = (hue + 360) % 360;
    if (h < 80 || h > 175) offPalette.push(`${literal} (hue ${Math.round(h)})`);
  }
  assert.ok(chromatic >= 10);
  assert.deepEqual(offPalette, [], "every chromatic helicoid color must be a green hue (no blue-violet)");
});

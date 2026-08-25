/**
 * The localized changelogs must not silently fall behind the English one.
 *
 * `changelogLocales[*].titles` maps to the release rows in site/changelog.html
 * POSITIONALLY — generate-site-locales.mjs consumes them as `copy.titles[titleIndex++]`
 * in row order. Add a release row without adding a title to every locale and every
 * localized title shifts by one.
 *
 * The generator already refuses to run on a mismatch, but NOTHING invoked the generator:
 * not a test, not CI, not an npm script. So the drift went unnoticed across five releases
 * (69 rows vs 64 titles) and the localized changelogs simply stopped at v1.9.4 while
 * con_e3cc8bb530 ("each supported locale must stay localized when entering the
 * changelog") said otherwise. This test is what makes the generator's guard actually run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-expect-error -- plain-JS tooling module, no type declarations
import { changelogLocales, countChangelogRows } from "../tooling/changelog-locales.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const changelogHtml = readFileSync(join(repoRoot, "site", "changelog.html"), "utf8");

const locales = changelogLocales as Record<string, { titles: string[]; dir: string; dateLocale: string }>;

test("every locale has exactly one changelog title per release row", () => {
  const rows = countChangelogRows(changelogHtml) as number;
  assert.ok(rows > 0, "the English changelog has release rows to translate");
  for (const [locale, copy] of Object.entries(locales)) {
    assert.equal(
      copy.titles.length,
      rows,
      `[${locale}/changelog] ${copy.titles.length} translated titles for ${rows} release rows — `
      + "titles map to rows POSITIONALLY, so this shifts every localized title. "
      + "Add the new release's title to tooling/changelog-locales.mjs for EVERY locale.",
    );
  }
});

test("no locale title is blank or left in English placeholder form", () => {
  for (const [locale, copy] of Object.entries(locales)) {
    copy.titles.forEach((title, i) => {
      assert.ok(title.trim().length > 0, `[${locale}] title #${i} is empty`);
      assert.ok(!/^TODO|^TRANSLATE|^FIXME/i.test(title.trim()), `[${locale}] title #${i} is a placeholder: ${title}`);
    });
  }
});

test("the newest locale titles line up with the newest English releases", () => {
  // Guards the ORDER, not just the count: a title appended to the end instead of prepended
  // keeps the count correct while mislabelling every release. The English source is
  // newest-first, so index 0 must correspond to the newest release row.
  const versions = [...changelogHtml.matchAll(/<span class="rel-tag">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.ok(versions.length >= 2, "at least two releases to compare");
  assert.ok(
    /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(versions[0] ?? ""),
    `newest row is not a version tag: ${versions[0]}`,
  );
  for (const [locale, copy] of Object.entries(locales)) {
    assert.equal(copy.titles.length, versions.length, `[${locale}] title count tracks the version-tag count`);
  }
});

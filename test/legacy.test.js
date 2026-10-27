// Parity test: the code version of the old Excel template must give exactly the
// same results as the sheet itself, row by row, on the same data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { legacyRow, legacyG, legacyI } from "../src/legacy.js";

const fx = JSON.parse(readFileSync(new URL("../data/legacy/nl-snapshot.json", import.meta.url), "utf8"));
const ctx = { brandPattern: fx.brandPattern, competitorPattern: fx.competitorPattern, existingKeywords: fx.existingKeywords };

test("every row matches the Excel snapshot in columns E, G, H and I", () => {
  const mismatches = [];
  for (const row of fx.rows) {
    const got = legacyRow(row, ctx);
    for (const col of ["E", "G", "H", "I"]) {
      if (got[col] !== row.expected[col]) {
        mismatches.push(`row ${row.excelRow} col ${col}: sheet=${row.expected[col]} code=${got[col]}`);
      }
    }
  }
  assert.equal(fx.rows.length, 225);
  assert.deepEqual(mismatches, [], `${mismatches.length} mismatches`);
});

test("the comparison is valid: keywords contain no regex special characters", () => {
  // Google Sheets uses RE2 and JavaScript uses its own regex engine. They agree on
  // plain words; this guard fails if a future keyword would make them differ.
  const special = fx.existingKeywords.filter((k) => /[\\.+*?()[\]{}^$|]/.test(k.C));
  assert.deepEqual(special, []);
});

// The tests below pin down the sheet's known quirks, so the findings in
// docs/DESIGN.md are backed by code, not just by description.

test("quirk: the column-A version of column I always returns Match", () => {
  const rows = fx.rows.filter((r) => r.formulaI === "keyword_col_A");
  assert.deepEqual(rows.map((r) => r.excelRow), [6, 7]);
  for (const r of rows) {
    assert.equal(legacyI(r.searchTerm, r.adGroup, fx.existingKeywords, "keyword_col_A"), "Match");
    // With the correct column the answer is different:
    assert.equal(legacyI(r.searchTerm, r.adGroup, fx.existingKeywords, "keyword_col_C"), "No Match");
  }
});

test("quirk: the REGEXEXTRACT version of column G stops at spaces and fails on 'kwd_' ad groups", () => {
  const ag = "dewalt_emeaanz_nl_ga_conv_NoABTest_rsa_camp_mp_pros_nl+nl_generic_SDS Plus rotary hammers";
  assert.equal(legacyG(ag, "find_or_last_segment"), "generic_SDS Plus rotary hammers");
  assert.equal(legacyG(ag, "regexextract"), "generic_SDS");
  assert.equal(legacyG("dewalt_emeaanz_nl_ga_conv__rsa_AO_mp_pros_kwd_sanders", "regexextract"), "#N/A");
});

test("quirk: every search term in the 'kwd_sanders' ad group gets H = No Match", () => {
  const sanders = fx.rows.filter((r) => r.adGroup.endsWith("kwd_sanders"));
  assert.equal(sanders.length, 101);
  assert.ok(sanders.every((r) => legacyRow(r, ctx).H === "No Match"));
  // ...although every one of them sits in a campaign named "..._search_generic".
  assert.ok(sanders.every((r) => r.campaign.endsWith("_search_generic")));
});

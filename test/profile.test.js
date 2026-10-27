import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateProfile, loadProfile, ProfileError } from "../src/profile.js";

const dewalt = () => JSON.parse(readFileSync(new URL("../profiles/dewalt.json", import.meta.url), "utf8"));
const errorsAfter = (change) => { const p = dewalt(); change(p); return validateProfile(p); };

test("the DEWALT profile is valid", () => {
  assert.deepEqual(validateProfile(dewalt()), []);
  assert.doesNotThrow(() => loadProfile(dewalt()));
});

test("fixed safety rules cannot be configured, and the error says why", () => {
  const errs = errorsAfter((p) => { p.rules.D.autoApprove = true; p.applyToAccount = true; });
  assert.ok(errs.some((e) => /autoApprove: not configurable\. Every change needs human approval/.test(e)));
  assert.ok(errs.some((e) => /applyToAccount: not configurable/.test(e)));
});

test("unknown settings and values outside the allowed options are rejected", () => {
  const errs = errorsAfter((p) => {
    p.rules.brand.matchType = "broad_modified";
    p.rules.C.options = ["delete_campaign"];
    p.rules.retailer.colour = "red";
  });
  assert.ok(errs.some((e) => e.startsWith("rules.brand.matchType: must be one of broad, phrase, exact")));
  assert.ok(errs.some((e) => e.startsWith("rules.C.options: must be one of")));
  assert.ok(errs.some((e) => e === "rules.retailer.colour: unknown setting"));
});

test("list problems are caught before any run: bad pattern, empty-matching pattern, duplicates", () => {
  const errs = errorsAfter((p) => {
    p.lists.brand.push({ term: "d[cw", mode: "pattern" });
    p.lists.brand.push({ term: "x*", mode: "pattern" });
    p.lists.competitor.push({ term: "Makita", mode: "substring" });
  });
  assert.ok(errs.some((e) => /invalid pattern/.test(e)));
  assert.ok(errs.some((e) => /pattern matches empty text/.test(e)));
  assert.ok(errs.some((e) => /duplicate term "Makita"/.test(e)));
});

test("a market can only belong to one shared negative list", () => {
  const errs = errorsAfter((p) => p.sharedNegativeLists.push({ name: "Second list", markets: ["be"] }));
  assert.ok(errs.some((e) => /market "be" is already in list/.test(e)));
});

test("only generic campaigns can be processed in this version", () => {
  const errs = errorsAfter((p) => { p.campaigns.typePatterns.brand = "_search_brand$"; p.campaigns.processedTypes = ["generic", "brand"]; });
  assert.ok(errs.some((e) => e.startsWith("campaigns.processedTypes: must be one of generic")));
});

test("loadProfile throws with every problem listed", () => {
  const p = dewalt();
  delete p.productDomain;
  p.rules.A.keywordMatchTypes = [];
  assert.throws(() => loadProfile(p), (e) => e instanceof ProfileError && e.errors.length === 2);
});

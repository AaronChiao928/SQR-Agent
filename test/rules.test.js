import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyRules } from "../src/rules.js";
import { loadProfile } from "../src/profile.js";
import { diffLegacyVsNew } from "../src/diff.js";

const dewalt = () => loadProfile(JSON.parse(readFileSync(new URL("../profiles/dewalt.json", import.meta.url), "utf8")));
const NL = "dewalt_emeaanz_construction_saws_25_nl_nl_ga_conv_SearchIndiciaCen_search_generic";
const BE = "dewalt_emeaanz_construction_saws_25_be_nl_ga_conv_SearchIndiciaCen_search_generic";
const AG = "dewalt_emeaanz_nl_ga_conv_NoABTest_rsa_camp_mp_pros_nl+nl_generic_saws_circular sawing";
let n = 0;
const row = (searchTerm, campaign = NL, adGroup = AG) => ({ id: `S${++n}`, searchTerm, campaign, adGroup });

test("rows outside generic campaigns, or with no recognisable market, are not processed", () => {
  const r = applyRules(
    [row("dch273", "dewalt_emeaanz_drills_25_nl_nl_ga_conv_search_brand"), row("dch273", "some_other_campaign_search_generic"), row("dch273")],
    dewalt()
  );
  assert.deepEqual(r.notProcessed.map((x) => x.reason), ["CAMPAIGN_TYPE_UNKNOWN", "MARKET_UNKNOWN"]);
  assert.equal(r.negatives.length, 1);
});

test("a term hitting several lists gives one negative per trigger word (D10), and is not sent to the AI", () => {
  const r = applyRules([row("makita vs dewalt toolnation")], dewalt());
  assert.deepEqual(r.negatives.map((x) => [x.text, x.categories[0]]).sort(), [["dewalt", "brand"], ["makita", "competitor"], ["toolnation", "retailer"]]);
  assert.deepEqual(r.aiQueue, []);
});

test("negatives are de-duplicated across rows and keep every source row", () => {
  const rows = [row("dch273"), row("dch273 accu"), row("DCH273", BE)];
  const r = applyRules(rows, dewalt());
  assert.equal(r.negatives.length, 1); // NL and BE share one list (D9)
  assert.deepEqual(r.negatives[0].sourceRowIds, rows.map((x) => x.id));
  assert.equal(r.negatives[0].level, "shared_list");
  assert.equal(r.negatives[0].matchType, "broad");
});

test("terms with no list hit go to the AI queue", () => {
  const rows = [row("cirkelzaag accu"), row("betaalbare cirkelzaag")];
  const r = applyRules(rows, dewalt());
  assert.deepEqual(r.aiQueue, rows.map((x) => x.id));
});

test("market-specific retailers: 'hubo' is a retailer in BE only", () => {
  const be = row("hubo cirkelzaag", BE), nl = row("hubo cirkelzaag", NL);
  const r = applyRules([be, nl], dewalt());
  assert.equal(r.negatives[0].text, "hubo");
  assert.deepEqual(r.aiQueue, [nl.id]);
});

test("a disabled rule category flags its hits for the user and sends nothing to the AI (D23)", () => {
  const p = dewalt();
  p.rules.retailer.enabled = false;
  const r = applyRules([row("dewalt gamma")], p);
  assert.deepEqual(r.negatives.map((x) => x.text), ["dewalt"]); // enabled category still applies
  assert.deepEqual(r.flags.map((f) => [f.category, f.triggers]), [["retailer", ["gamma"]]]);
  assert.deepEqual(r.aiQueue, []);
});

test("settings change the suggestion: whole term at ad group level", () => {
  const p = dewalt();
  Object.assign(p.rules.competitor, { negativeForm: "whole_term", level: "ad_group", matchType: "exact" });
  const r = applyRules([row("makita cirkelzaag")], p);
  assert.deepEqual(
    { text: r.negatives[0].text, level: r.negatives[0].level, adGroup: r.negatives[0].adGroup, matchType: r.negatives[0].matchType },
    { text: "makita cirkelzaag", level: "ad_group", adGroup: AG, matchType: "exact" }
  );
});

test("difference report on the Excel data: exactly 19 changes, each explained by a decision", () => {
  const fx = JSON.parse(readFileSync(new URL("../data/legacy/nl-snapshot.json", import.meta.url), "utf8"));
  const d = diffLegacyVsNew(fx, dewalt());
  assert.equal(d.rowsCompared, 220);
  assert.equal(d.changes.length, 19);
  const by = (f) => d.changes.filter(f).map((c) => c.excelRow);
  // D7: new retailer category (16 rows)
  assert.equal(by((c) => c.old === "none" && c.new === "retailer").length, 16);
  // D4: misspelling "dewald" now counts as brand
  assert.deepEqual(by((c) => c.old === "none" && c.new === "brand"), [18, 64]);
  // D3: SDS removed from the brand list
  assert.deepEqual(by((c) => c.old === "brand" && c.new === "none"), [185]);
  // Matching on the original instead of the translation changed nothing else:
  assert.equal(d.counts["brand -> brand"], 57);
  assert.equal(d.counts["competitor -> competitor"], 1);
});

test("every historical negative found in this report is covered by a new rule-based negative", () => {
  const fx = JSON.parse(readFileSync(new URL("../data/legacy/nl-snapshot.json", import.meta.url), "utf8"));
  const inReport = new Set(fx.rows.map((r) => r.searchTerm.trim().toLowerCase()).filter(Boolean));
  const historical = [...new Set(fx.historicalNegatives.map((x) => String(x.Keyword).trim().toLowerCase()))].filter((k) => inReport.has(k));
  const rows = fx.rows.filter((r) => r.searchTerm).map((r, i) => ({ id: `S${i + 1}`, ...r }));
  const negs = applyRules(rows, dewalt()).negatives.map((x) => x.text);
  // A Broad negative blocks any search containing all its words.
  const covered = historical.filter((h) => negs.some((n) => n.split(" ").every((w) => h.split(" ").includes(w))));
  assert.equal(historical.length, 15);
  assert.deepEqual(covered, historical);
});

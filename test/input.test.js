import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSearchTermsReport, InputError } from "../src/input.js";

const HEADER = "Search term,Match type,Added/Excluded,Campaign,Ad group,Clicks,Cost";
const csv = (...lines) => lines.join("\r\n") + "\r\n";
const codes = (res) => res.issues.map((i) => i.code);

test("finds the header below title lines, keeps needed columns, ignores performance columns", () => {
  const res = loadSearchTermsReport(
    csv("Search terms report", "1 September 2026 - 30 September 2026", HEADER, "schuurmachine,Broad match,None,Camp_generic,AG_sanders,12,3.40")
  );
  assert.equal(res.meta.headerLine, 3);
  assert.deepEqual(res.rows, [
    { id: "S1", line: 4, searchTerm: "schuurmachine", matchType: "Broad match", campaign: "Camp_generic", adGroup: "AG_sanders" },
  ]);
  assert.deepEqual(res.meta.ignoredColumns, ["Clicks", "Cost"]);
});

test("sets aside blank search terms, missing campaign/ad group and already added/excluded rows, with reasons", () => {
  const res = loadSearchTermsReport(
    csv(
      HEADER,
      "ok term,Broad match,None,C1,AG1,1,1",
      ",Broad match,None,C1,AG1,1,1",
      "no adgroup,Broad match,None,C1,,1,1",
      "already there,Exact match,Excluded,C1,AG1,1,1",
      "Total: Search terms,,,,,4,4"
    )
  );
  assert.deepEqual(res.rows.map((r) => r.searchTerm), ["ok term"]);
  assert.deepEqual(res.excluded.map((e) => e.reason), [
    "BLANK_SEARCH_TERM",
    "MISSING_CAMPAIGN_OR_AD_GROUP",
    "ALREADY_ADDED_OR_EXCLUDED",
  ]);
  assert.ok(codes(res).includes("TOTAL_ROWS"));
  assert.ok(res.issues.filter((i) => i.level === "warning").length === 3);
});

test("a missing required column stops the run with a clear message", () => {
  assert.throws(
    () => loadSearchTermsReport(csv("Search term,Campaign,Ad group", "x,C1,AG1")),
    (e) => e instanceof InputError && /"match type"/.test(e.message)
  );
});

test("reads tab-separated UTF-16 files (another common export format)", () => {
  const text = "\uFEFF" + ["Search term\tMatch type\tCampaign\tAd group", "décapeur thermique\tBroad match\tC_fr\tAG1"].join("\r\n");
  const bytes = Buffer.from(text, "utf16le");
  const res = loadSearchTermsReport(bytes);
  assert.equal(res.meta.separator, "\t");
  assert.equal(res.rows[0].searchTerm, "décapeur thermique");
  assert.ok(codes(res).includes("NO_ADDED_EXCLUDED_COLUMN"));
});

test("quoted fields with commas are read correctly", () => {
  const res = loadSearchTermsReport(csv(HEADER, '"saw, table",Broad match,None,"Camp, A",AG1,1,1'));
  assert.equal(res.rows[0].searchTerm, "saw, table");
  assert.equal(res.rows[0].campaign, "Camp, A");
});

test("duplicates are kept and reported, not silently dropped", () => {
  const res = loadSearchTermsReport(csv(HEADER, "dch273,Broad match,None,C1,AG1,1,1", "DCH273,Exact match,None,C1,AG1,1,1"));
  assert.equal(res.rows.length, 2);
  assert.ok(codes(res).includes("DUPLICATE_ROWS"));
});

test("demo export built from the Excel template: 220 rows kept, 5 empty rows reported", () => {
  const res = loadSearchTermsReport(readFileSync(new URL("../data/demo/nl-search-terms-export.csv", import.meta.url)));
  assert.equal(res.rows.length, 220);
  assert.equal(res.excluded.length, 0);
  assert.match(res.issues.find((i) => i.code === "EMPTY_ROWS").message, /^5 /);
  assert.ok(codes(res).includes("TOTAL_ROWS"));
});

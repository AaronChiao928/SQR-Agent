// Build data/demo/nl-search-terms-export.csv from the rows of the original Excel template,
// laid out like a Google Ads search terms report download (title lines above the header,
// a total row at the bottom). Only the columns the template had are included; the
// template contained no performance data, so none is invented here.
//
// Usage: node scripts/build-demo-export.js
import { readFileSync, writeFileSync } from "node:fs";

const fx = JSON.parse(readFileSync(new URL("../data/legacy/nl-snapshot.json", import.meta.url), "utf8"));
const q = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

const lines = [
  "Search terms report",
  "Demo file: rows from SQR_master_template.xlsx (sheet 'NL Search terms'); date range not available",
  ["Search term", "Match type", "Added/Excluded", "Campaign", "Ad group"].join(","),
];
for (const r of fx.rows) {
  // The template's last rows are empty; keep them empty so the input check has to handle them.
  if (!r.searchTerm && !r.campaign && !r.adGroup) { lines.push(",,,,"); continue; }
  lines.push([r.searchTerm, r.matchType, "None", r.campaign, r.adGroup].map(q).join(","));
}
lines.push("Total: Search terms,,,,");

const out = new URL("../data/demo/nl-search-terms-export.csv", import.meta.url);
writeFileSync(out, lines.join("\r\n") + "\r\n", "utf8");
console.log(`${fx.rows.length} template rows -> ${out.pathname}`);

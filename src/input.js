// Step 1: read the Google Ads search terms report and check it before anything else runs.
//
// The user uploads the report exactly as downloaded from Google Ads (already filtered
// to terms with at least one click that are not yet added or excluded). This module:
//   - finds the real header row (exports have title/date lines above it)
//   - keeps only the columns the agent needs; performance columns are ignored
//   - skips total rows and empty rows, and says so
//   - sets aside rows it cannot process, with a reason, instead of guessing
//   - gives every kept row a stable ID (S1, S2, ...) that later steps must refer to
//
// Rule of thumb: missing means missing. A blank field is never filled in or treated as valid.

import { readTable } from "../shared/tabular.js";

export const REQUIRED_COLUMNS = {
  searchTerm: ["search term"],
  matchType: ["match type"],
  campaign: ["campaign"],
  adGroup: ["ad group"],
};
export const OPTIONAL_COLUMNS = {
  addedExcluded: ["added/excluded"],
};
// Values of the Added/Excluded column that mean "not yet in the account".
const NOT_YET_ADDED = new Set(["", "none", "--", "—"]);

export class InputError extends Error {}

const clean = (s) => String(s ?? "").trim();

/**
 * @param input  file contents (bytes or text) of a CSV/TSV export
 * @returns {{ rows, excluded, issues, meta }}
 *   rows:     kept rows [{ id, line, searchTerm, matchType, campaign, adGroup }]
 *   excluded: rows set aside [{ line, reason, searchTerm, campaign, adGroup, value? }]
 *   issues:   summary messages [{ level: "info"|"warning", code, message, lines? }]
 */
export function loadSearchTermsReport(input) {
  const t = readTable(input, REQUIRED_COLUMNS, OPTIONAL_COLUMNS);
  if (!t || t.headerIndex < 0) {
    const missing = Object.keys(REQUIRED_COLUMNS).filter((k) => !t?.best?.found.includes(k));
    const names = missing.map((k) => `"${REQUIRED_COLUMNS[k][0]}"`).join(", ");
    throw new InputError(
      `Could not find the header row. Missing column(s): ${names}. ` +
        `Download the search terms report with English column names, or check the file is the right report.`
    );
  }

  const { rows: raw, map, headerIndex } = t;
  const header = raw[headerIndex].map(clean);
  const usedCols = new Set(Object.values(map));
  const ignoredColumns = header.filter((h, i) => h && !usedCols.has(i));

  const rows = [], excluded = [], issues = [];
  let emptyRows = 0;
  const totalLines = [];

  for (let i = headerIndex + 1; i < raw.length; i++) {
    const r = raw[i];
    const line = i + 1; // 1-based line number in the file, for messages
    const get = (k) => (k in map ? clean(r[map[k]]) : "");
    const rec = {
      searchTerm: get("searchTerm"),
      matchType: get("matchType"),
      campaign: get("campaign"),
      adGroup: get("adGroup"),
    };

    if (r.every((c) => clean(c) === "")) { emptyRows++; continue; }
    if (/^total\b/i.test(clean(r[0])) || /^total\b/i.test(rec.searchTerm)) { totalLines.push(line); continue; }

    if (!rec.searchTerm) { excluded.push({ line, reason: "BLANK_SEARCH_TERM", ...rec }); continue; }
    if (!rec.campaign || !rec.adGroup) { excluded.push({ line, reason: "MISSING_CAMPAIGN_OR_AD_GROUP", ...rec }); continue; }
    if ("addedExcluded" in map) {
      const v = get("addedExcluded");
      if (!NOT_YET_ADDED.has(v.toLowerCase())) {
        excluded.push({ line, reason: "ALREADY_ADDED_OR_EXCLUDED", value: v, ...rec });
        continue;
      }
    }
    rows.push({ id: `S${rows.length + 1}`, line, ...rec });
  }

  // Duplicates are kept (the report can list a term twice, e.g. once per triggering keyword);
  // suggestions are de-duplicated later. They are reported so nothing is silent.
  const seen = new Map();
  for (const r of rows) {
    const key = [r.searchTerm, r.campaign, r.adGroup].map((x) => x.toLowerCase()).join("\u0000");
    seen.set(key, [...(seen.get(key) || []), r.line]);
  }
  const dupLines = [...seen.values()].filter((l) => l.length > 1);

  if (emptyRows) issues.push({ level: "info", code: "EMPTY_ROWS", message: `${emptyRows} empty row(s) skipped.` });
  if (totalLines.length)
    issues.push({ level: "info", code: "TOTAL_ROWS", message: `${totalLines.length} total row(s) skipped.`, lines: totalLines });
  if (ignoredColumns.length)
    issues.push({ level: "info", code: "IGNORED_COLUMNS", message: `Columns not used by the agent: ${ignoredColumns.join(", ")}.` });
  if (!("addedExcluded" in map))
    issues.push({
      level: "info",
      code: "NO_ADDED_EXCLUDED_COLUMN",
      message: "No Added/Excluded column: assuming the report was filtered to terms not yet added or excluded.",
    });
  for (const reason of ["BLANK_SEARCH_TERM", "MISSING_CAMPAIGN_OR_AD_GROUP", "ALREADY_ADDED_OR_EXCLUDED"]) {
    const lines = excluded.filter((e) => e.reason === reason).map((e) => e.line);
    if (lines.length) issues.push({ level: "warning", code: reason, message: MESSAGES[reason](lines.length), lines });
  }
  if (dupLines.length)
    issues.push({
      level: "info",
      code: "DUPLICATE_ROWS",
      message: `${dupLines.length} search term(s) appear more than once in the same ad group; kept, and de-duplicated in the suggestions.`,
      lines: dupLines.flat(),
    });
  if (!rows.length) issues.push({ level: "warning", code: "NO_ROWS", message: "No rows left to process." });

  return { rows, excluded, issues, meta: { separator: t.sep, headerLine: headerIndex + 1, ignoredColumns } };
}

const MESSAGES = {
  BLANK_SEARCH_TERM: (n) => `${n} row(s) have no search term and were set aside.`,
  MISSING_CAMPAIGN_OR_AD_GROUP: (n) => `${n} row(s) have no campaign or ad group and were set aside.`,
  ALREADY_ADDED_OR_EXCLUDED: (n) =>
    `${n} row(s) are already added or excluded in the account and were set aside. Filter them out when downloading.`,
};

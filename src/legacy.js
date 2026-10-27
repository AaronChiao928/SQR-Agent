// Faithful reproduction of the original SQR Excel template (Google Sheets).
//
// Purpose: prove that the agent understands the existing process exactly.
// It reproduces columns E, G, H and I of the "NL Search terms" sheet, including
// the sheet's known quirks, so that test/legacy.test.js can compare it row by row
// with the sheet's own results. The new agent does NOT use this module to make
// decisions; the new rules live elsewhere.
//
// Known quirks reproduced on purpose (see docs/DESIGN.md, "Legacy findings"):
//   - Column E looks for brand/competitor names in the machine translation,
//     not in the original search term, and is case-sensitive.
//   - Column G has two formula versions; the REGEXEXTRACT version stops at the
//     first space and returns #N/A for ad groups without "brand_"/"generic_".
//   - Column H compares E with the ad group (via G), not with the campaign.
//   - Column I has two versions; the one reading the empty column A of the
//     keyword sheet always returns "Match".
//   - Error values are compared as text in column H, which is how they appear
//     in the exported snapshot (in live Google Sheets they would propagate).

const ERRORS = new Set(["#VALUE!", "#N/A", "#REF!", "#NAME?", "#DIV/0!", "#NUM!", "#NULL!", "#ERROR!"]);
export const isError = (x) => typeof x === "string" && ERRORS.has(x);

/** Google Sheets TRIM: remove leading/trailing spaces and collapse inner runs of spaces. */
const sheetsTrim = (s) => String(s).replace(/ +/g, " ").trim();

/** Column E: Brand / Competitor / Generic, judged on the translation (column B). */
export function legacyE(translation, brandPattern, competitorPattern) {
  if (isError(translation)) return "#VALUE!";
  if (new RegExp(brandPattern).test(translation)) return "Brand";
  if (new RegExp(competitorPattern).test(translation)) return "Competitor";
  return "Generic";
}

/** Column G: the "type" part of the ad group name. Two formula versions exist. */
export function legacyG(adGroup, version) {
  const f = String(adGroup ?? "");
  if (version === "find_or_last_segment") {
    if (f.includes("brand_")) return f.slice(f.indexOf("brand_"));
    if (f.includes("generic_")) return f.slice(f.indexOf("generic_"));
    const parts = f.split("_");
    return sheetsTrim(parts[parts.length - 1]);
  }
  if (version === "regexextract") {
    const m = f.match(/(brand\s*_[a-zA-Z_]+|generic\s*_[a-zA-Z_]+)/);
    return m ? m[1] : "#N/A";
  }
  throw new Error(`Unknown column G formula version: ${version}`);
}

/** Column H: does the start of G equal E (case-insensitive)? */
export function legacyH(e, g) {
  const E = String(e).toLowerCase();
  const G = String(g).toLowerCase();
  return E === G.slice(0, E.length) ? "Match" : "No Match";
}

/**
 * Column I: does the search term contain any keyword listed for the same ad group?
 * FILTER(column, adGroupColumn = adGroup) -> TEXTJOIN("|", TRUE, ...) -> REGEXMATCH(term, joined).
 * `version` says which keyword-sheet column the row's formula reads (C = keywords, A = empty).
 */
export function legacyI(searchTerm, adGroup, keywordRows, version) {
  const col = { keyword_col_C: "C", keyword_col_A: "A" }[version];
  if (!col) throw new Error(`Unknown column I formula version: ${version}`);
  const ag = String(adGroup ?? "").toLowerCase(); // Sheets compares text case-insensitively
  const hits = keywordRows.filter((k) => String(k.E).toLowerCase() === ag);
  // A whole-column FILTER on a blank ad group also matches the sheet's empty rows,
  // so it returns blanks (not an error). A non-blank ad group with no rows is #N/A.
  if (!hits.length && ag !== "") return "#N/A";
  const pattern = hits.map((k) => k[col]).filter((x) => x !== "" && x != null).join("|");
  // An empty pattern matches everything: this is why the column-A version always says "Match".
  return new RegExp(pattern).test(String(searchTerm ?? "")) ? "Match" : "No Match";
}

/** Run all four columns for one row of the sheet. */
export function legacyRow(row, ctx) {
  const E = legacyE(row.translation, ctx.brandPattern, ctx.competitorPattern);
  const G = legacyG(row.adGroup, row.formulaG);
  const H = legacyH(E, G);
  const I = legacyI(row.searchTerm, row.adGroup, ctx.existingKeywords, row.formulaI);
  return { E, G, H, I };
}

"""
One-off script: turn the original SQR Excel template into a JSON fixture
for the legacy parity test (test/legacy.test.js).

For every row of the "NL Search terms" sheet it records:
  - the inputs (search term, cached translation, match type, campaign, ad group)
  - which version of each formula that row actually uses (the sheet contains two
    versions of the column G formula and two versions of the column I formula)
  - the results the sheet shows (columns E, G, H, I): the expected answers

The translation comes from the sheet's cached values, because GOOGLETRANSLATE
cannot be re-run outside Google Sheets.

Usage: python3 scripts/extract-legacy-fixture.py <template.xlsx> <out.json>
"""
import json
import re
import sys

import openpyxl

SHEET, KW_SHEET = "NL Search terms", "NL Existing KWs"
FIRST_ROW = 6


def variant_g(formula):
    if "REGEXEXTRACT" in formula:
        return "regexextract"
    if "TRIM(RIGHT(SUBSTITUTE" in formula:
        return "find_or_last_segment"
    raise ValueError("Unknown column G formula: " + formula[:120])


def variant_i(formula):
    m = re.search(r"FILTER\('NL Existing KWs'!\$([A-Z]):\$\1", formula)
    if not m:
        raise ValueError("Unknown column I formula: " + formula[:120])
    return "keyword_col_" + m.group(1)


def main(src, out):
    wf = openpyxl.load_workbook(src)                   # formulas
    wv = openpyxl.load_workbook(src, data_only=True)   # cached values
    f, v = wf[SHEET], wv[SHEET]

    # Guard: the legacy code hard-codes these formulas, so fail loudly if they differ.
    for r in range(FIRST_ROW, f.max_row + 1):
        e, h = f.cell(r, 5).value, f.cell(r, 8).value
        assert "REGEXMATCH($B$6:$B$2664, $E$4)" in e and "REGEXMATCH($B$6:$B$2664, $E$3)" in e, r
        assert h == f'=IF(LOWER(E{r}) = LOWER(LEFT(G{r}, LEN(E{r}))), "Match", "No Match")', r

    rows = []
    for r in range(FIRST_ROW, f.max_row + 1):
        def val(c):
            return v.cell(r, c).value
        rows.append({
            "excelRow": r,
            "searchTerm": val(1) or "",
            "translation": val(2) if val(2) is not None else "",
            "matchType": val(3) or "",
            "campaign": val(4) or "",
            "adGroup": val(6) or "",
            "formulaG": variant_g(f.cell(r, 7).value),
            "formulaI": variant_i(f.cell(r, 9).value),
            "expected": {"E": val(5), "G": val(7), "H": val(8), "I": val(9)},
        })

    k = wv[KW_SHEET]
    keywords = [{"A": k.cell(r, 1).value or "", "C": k.cell(r, 3).value or "", "E": k.cell(r, 5).value or ""}
                for r in range(2, k.max_row + 1)]

    def tab(name):
        ws = wv[name]
        head = [ws.cell(1, c).value for c in range(1, ws.max_column + 1)]
        return [{h: ws.cell(r, c + 1).value for c, h in enumerate(head)}
                for r in range(2, ws.max_row + 1) if ws.cell(r, 1).value]

    fixture = {
        "source": f"SQR_master_template.xlsx (Google Sheets export), sheet '{SHEET}'",
        "brandPattern": v["E4"].value,
        "competitorPattern": v["E3"].value,
        "rows": rows,
        "existingKeywords": keywords,
        # The analyst's past output tabs (filled by hand), used to check the new rules against practice.
        "historicalNegatives": tab("NL Negatives"),
        "historicalPositives": tab("NL Positives"),
    }
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(fixture, fh, ensure_ascii=False, indent=1)
    print(f"{len(rows)} rows, {len(keywords)} existing keywords -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

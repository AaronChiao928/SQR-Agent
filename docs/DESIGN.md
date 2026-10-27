# Design document: SQR Agent

Status: prototype, stages 1–3 of 5 built · Owner: Aaron Chiao · Last updated: October 2026

This document will be completed in stage 5. Sections 1 and 2 are kept up to date from stage 1 onwards so that decisions are recorded when they are made.

## 1. Legacy process and findings

The starting point is a Google Sheets template (`data/legacy/SQR_master_template.xlsx`) used to process Google Ads search terms reports. The analyst pastes the report into the sheet; formulas then:

| Column | What it does |
|---|---|
| B Translation | `GOOGLETRANSLATE` of the search term into English |
| E Brand/Generic | Brand if the translation matches the brand regex (cell E4), else Competitor if it matches the competitor regex (E3), else Generic |
| G | The "type" part of the ad group name: from `brand_` or `generic_` to the end, otherwise the last `_` segment |
| H Campaign Match Status | Match if E equals the start of G (case-insensitive) |
| I Keyword Match Status | Match if the search term contains any existing keyword of the same ad group (sheet "NL Existing KWs") |

The analyst then filters on H and I and copies terms into a Negatives tab (Broad) and a Positives tab (Phrase and Exact), both in Google Ads Editor bulk-upload format.

`src/legacy.js` reproduces columns E, G, H and I. `test/legacy.test.js` compares it with the sheet: **225 rows × 4 columns, 0 mismatches**. A mutation check confirmed the test detects deliberate changes (for example, correcting the two rows described in L1 produces 2 mismatches).

Findings, all reproduced on purpose by the legacy code and pinned by tests:

| # | Finding | Effect |
|---|---|---|
| L1 | Rows 6–7 of column I read the empty column A of the keyword sheet | An empty pattern matches everything, so both rows always show Match (correct answer: No Match) |
| L2 | Rows 215–230 of column G use a different formula (`REGEXEXTRACT`) | Stops at the first space (`generic_SDS`) and returns #N/A for ad groups without `brand_`/`generic_` |
| L3 | Column H compares with the ad group, not the campaign | All 101 terms in the `kwd_sanders` ad group show No Match, although their campaigns end in `_search_generic` |
| L4 | Column I requires the search term to contain a whole existing keyword | Core short terms such as `schuurmachine` show No Match because only longer keywords exist |
| L5 | Brand/competitor regexes are case-sensitive substrings on the machine translation | `DeWalt`/`DEWALT` are missed; `SDS` (a chuck standard, not a brand) is classed as Brand; `dewald` is classed as Generic |
| L6 | No retailer category | `toolnation` (9 rows), `gamma`, `action`, `klium` are classed as Generic |
| L7 | Applying "both Match → Positives, rest → Negatives" mechanically gives 12 positives and 208 negatives, including core sander terms | In practice the analyst filtered by hand; the output tabs do not follow the rule mechanically |
| L8 | Error values in G are stored as text in the export | Column H treats them as text ("No Match"); in live Sheets they would propagate as errors |

## 2. Decision record

Decisions made with the process owner during design. "Rule" = applied by code; "AI" = model judgement; every resulting change needs human approval.

| # | Decision | Reason |
|---|---|---|
| D1 | Scope: generic campaigns only. Brand campaigns and campaigns whose type cannot be identified get no suggestions and are listed as "not processed" | The current strategy runs generic campaigns only. Out-of-scope input is reported, never processed silently |
| D2 | Rule: brand terms in a generic campaign are always negated | Established practice: every negative in the legacy output that appears in the sample is a brand model number |
| D3 | `SDS` is a generic product term, removed from the brand list | It is a chuck standard used by many brands; there is a generic SDS ad group |
| D4 | Brand misspellings (e.g. `dewald`) count as brand terms | Process owner's decision. A legacy positive keyword `dewald afkortzaag` in a generic campaign was an error |
| D5 | Rule: competitor terms in a generic campaign are always negated | Process owner's decision |
| D6 | Brand, competitor and retailer lists are fixed data in the brand profile. The AI may propose additions with a reason; they apply only after approval | Rules stay repeatable and traceable; the AI widens coverage without deciding on its own |
| D7 | Rule: retailer terms in a generic campaign are always negated | Process owner's decision |
| D8 | For brand, competitor and retailer hits, negate only the triggering word, Broad | One negative covers every future combination with that word |
| D9 | These negatives go into one shared negative keyword list attached to all generic campaigns; NL and BE share one list | The words never belong in any generic campaign. Wider effect, so the review screen states that the list applies to all generic campaigns |
| D10 | A term that hits several lists produces one negative per triggering word | Maximum coverage; negatives are de-duplicated |
| D11 | Remaining generic terms are classified by the AI: A matches this ad group's product; B relevant product but wrong ad group; C too broad; D unrelated | Product relevance needs language understanding; regex and keyword lists cannot judge it |
| D12 | B: negate the whole term in the current ad group (Broad) and add it to the correct ad group. The target is chosen from ad groups present in the report and verified by code | "Any search containing this term does not belong in this ad group." Every campaign and ad group appears in each report |
| D13 | A and B new keywords are added as both Phrase and Exact | Established practice |
| D14 | C is never actioned automatically. Options: negate in ad group, add to shared list, keep. Decided one by one or in bulk (preview first; bulk only touches undecided items; recorded as bulk in the log) | Many items, low individual risk. A deliberate relaxation of "approve each item"; all other categories stay one by one |
| D15 | D: whole search term, Broad, into the shared list, each approved individually | Process owner's decision; no word-picking by the AI needed |
| D16 | No existing-keyword list is used | It was a workaround for the lack of AI. Duplicates are prevented upstream (report filtered to terms not yet added or excluded). No negative-conflict check: keywords containing brand terms should not exist in generic campaigns |
| D17 | No performance data is used | The report is filtered upstream (at least one click) |
| D18 | Rules match the original search term, not the translation; matching is Unicode-aware and each list entry has its own mode (substring, whole word, or model-number pattern) | Deterministic and language-independent. Whole-word matching avoids `beta` matching Dutch `betaalbare`; substring matching catches compounds like `mydewalt` |
| D19 | If the translation hits a list but the original does not, the agent proposes adding the local spelling to the list instead of negating | Keeps the benefit of translation without letting a non-deterministic translation decide a negative |
| D20 | Any language is supported. Translation is done by the AI; lists have global and market-specific entries; market detection and shared-list mapping are configuration | The tool is meant for any market, not only Benelux |
| D21 | Everything brand-specific lives in a brand profile; a setup flow lets the AI draft a profile for a new brand, reviewed item by item | Brand-agnostic tool; same review component as the run |
| D22 | Processing rules are selectable per brand profile; DEWALT settings are the default preset. Fixed for every brand: no account access, human approval of every change, rules cannot be overridden by the AI, AI output must pass code checks | Business rules differ by brand; safety rules do not |
| D23 | A rule category that is switched off flags its hits like C (decided by the user) | Nothing is silently dropped or silently passed to the AI |
| D24 | Input is the Google Ads report as downloaded (CSV in stage 1; .xlsx planned). English column names in this version; a missing column stops the run with a clear message | No copy-paste into a template; no guessing of columns |
| D25 | Repository is private and uses the real sample data | Process owner's decision |
| D26 | The negative for a list hit is the whole word the hit sits in (`mydewalt`, not `dewalt`); for languages without spaces, the matched text | Google Ads negative keywords match whole words, so `dewalt` would not block the search `mydewalt`. Technical consequence of D8 |
| D27 | Profile settings are closed choices; unknown settings are rejected, and attempts to configure fixed safety rules (e.g. `autoApprove`) are rejected with the reason | Configuration cannot be used to switch off governance |
| D28 | `gereedschapcentrum` is not a retailer; it is left to the AI like any other generic term | Process owner's correction. It had been added by a bulk "add all" approval although it was marked as uncertain; uncertain items are now confirmed one by one |
| D29 | The AI step is one structured request per batch (per market, 40 items), not an agent loop with tools | Fixed input and output; extra tool rounds would add variance and cost without improving accuracy. Contrast with the first project, where the model chooses what to investigate |
| D30 | Identical terms in the same ad group are sent once (138 unique items for 144 rows in the sample) | Consistent answers for duplicates, lower cost |
| D31 | The AI may only refer to given IDs (items T*, ad groups G*). Code rejects unknown IDs, duplicates, categories outside A–D, B targets that do not exist, are in another market or are the current ad group, and missing reasons or translations | Same principle as the first project's numbered facts: the model can only point at things that exist |
| D32 | One retry, for the missing or invalid items only. Anything still unresolved goes to the user as "AI could not classify", decided like C. A failing model call never stops the run | Bounded cost; nothing is dropped or guessed |
| D33 | AI list proposals must name text that appears in the cited search terms; proposals already covered by a list are dropped | Prevents invented names entering the lists |
| D34 | Search terms are treated as untrusted text. The prompt says so, but the real protection is structural: the AI can only choose among fixed categories and existing ad groups, every answer is verified, and every change is approved by a person | A term containing instructions can at worst cause a rejected or reviewable answer (tested) |
| D35 | AI accuracy is measured against analyst labels (`data/eval/`), not assumed. Unlabelled items are left out of the score, not counted as wrong | The code tests prove how answers are handled, not whether they are right |
Initial lists agreed: brand `dewalt`, `dewald`, `dc`/`dw` + digits model numbers, product lines `flexvolt`, `powerstack`, `xr`. Competitors: Bosch, Makita, Beta, Rubi, Milwaukee, Metabo, Hilti, Festool, Ryobi, HiKOKI, Einhell, Worx, Mafell, Ferm, Powerplus, AEG, Hitachi, Skil, Dremel, Parkside, Black+Decker, Stanley (Stanley runs separate campaigns). Retailers (NL/BE): Toolnation, Gamma, Action, Klium, Karwei, Praxis, Hornbach, Hubo, Brico/Brico Plan-it, Toolstation, Bouwmaat, Fixami, Coolblue, Amazon, Lidl, Aldi, bol.com (`bol.com`/`bolcom` only), Marktplaats (bol.com and Marktplaats confirmed individually). `gereedschapcentrum` is not on the retailer list (see D28). These lists were drafted from general knowledge and approved by the process owner; they are not verified market research.

## 3. Results so far (sample data from the Excel template)

Measured on the 220 non-empty rows of the template. These are results of the prototype on one sample, not production figures.

| Check | Result |
|---|---|
| Legacy reproduction vs the sheet | 225 rows × 4 columns, 0 mismatches |
| Old vs new classification (`docs/reports/legacy-vs-new.md`) | 19 rows differ: 16 new retailer hits (D7), 2 `dewald` now brand (D4), 1 `sds boormachine` no longer brand (D3). The other 57 brand rows and 1 competitor row are unchanged, so matching the original instead of the translation (D18) changed nothing unintended |
| Old campaign-type check (column H) | 78 rows flagged by the old sheet are terms in generic campaigns with no list hit; 77 of them only because of the `kwd_sanders` ad group name (L3) |
| Routing | 76 rows handled by rules (38 negatives after de-duplication), 144 rows for the AI (stage 3), 0 out of scope |
| Historical practice | All 15 distinct historical negatives that appear in the sample are covered by the new rule-based negatives |
| AI step (code) | 51 tests in total. The AI step is tested with a fake model: good, incomplete, malformed and instruction-following answers. **No live model run yet**, so there is no accuracy figure; it will come from `npm run classify` + `node src/cli.js eval` once the labels exist |
| Multilingual matching | Tested on constructed examples (Dutch, French, German, Polish, Cyrillic, Greek, Japanese, Chinese); replacing the Unicode word boundary with a plain `\b` makes 3 of these tests fail |

## 4. Build plan

1. Legacy reproduction, parity test, input checks — **done**
2. Brand profile and rule layer; legacy-vs-new difference report — **done**
3. AI layer (translation, A–D classification, list proposals) and output verification — **done** (accuracy not yet measured)
4. Review screen and Google Ads Editor export (format to be checked against Google's documentation before building)
5. Brand-profile setup flow; DESIGN, SOP, LEARNING-GUIDE

The web prototype will be generated from `src/` by a build step, so there is one implementation, not two. Components intended for reuse across projects live in `shared/`.

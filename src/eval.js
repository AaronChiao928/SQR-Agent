// Measure how well the AI classifies, against labels written by the analyst.
//
// The tests in test/classify.test.js prove what the code does with model answers.
// They cannot say whether the model's categories are right. This module does that:
// compare a saved run (runs/<time>.json) with a labels file filled in by a person.

import { readTable } from "../shared/tabular.js";

const LABEL_COLUMNS = {
  term: ["search term"],
  campaign: ["campaign"],
  adGroup: ["ad group"],
  expected: ["expected category"],
};
const OPTIONAL = { expectedTarget: ["expected target ad group"], note: ["note"] };
const key = (term, campaign, adGroup) => [term.trim().toLowerCase(), campaign.trim(), adGroup.trim()].join("\u0000");

/**
 * CSV for the analyst to fill in: one line per unique AI item.
 * `helpTranslations` (optional, term -> text) adds a reference column; it is not read back.
 */
export function labelsTemplate(aiItems, helpTranslations = null) {
  const q = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
  const head = ["Search term", "Campaign", "Ad group", "Expected category", "Expected target ad group", "Note"];
  if (helpTranslations) head.splice(1, 0, "Translation (reference only)");
  const lines = [head.join(",")];
  for (const i of aiItems) {
    const cells = [i.term, i.campaign, i.adGroup, "", "", ""];
    if (helpTranslations) cells.splice(1, 0, helpTranslations[i.term.toLowerCase()] ?? "");
    lines.push(cells.map(q).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export function readLabels(input) {
  const t = readTable(input, LABEL_COLUMNS, OPTIONAL);
  if (!t || t.headerIndex < 0) throw new Error("Labels file: header row not found");
  const labels = new Map(), problems = [];
  for (let i = t.headerIndex + 1; i < t.rows.length; i++) {
    const r = t.rows[i], get = (k) => (k in t.map ? String(r[t.map[k]] ?? "").trim() : "");
    if (!get("term")) continue;
    const exp = get("expected").toUpperCase();
    if (!exp) continue; // not labelled yet: left out of the evaluation, not counted as wrong
    if (!["A", "B", "C", "D"].includes(exp)) { problems.push(`line ${i + 1}: expected category must be A, B, C or D`); continue; }
    labels.set(key(get("term"), get("campaign"), get("adGroup")), { expected: exp, expectedTarget: get("expectedTarget") || null, line: i + 1 });
  }
  return { labels, problems };
}

/** Compare a run with the labels. */
export function evaluate(run, labels) {
  const groupById = Object.fromEntries(run.adGroups.map((g) => [g.id, g]));
  const confusion = {}; // expected -> predicted -> count
  const disagreements = [];
  let compared = 0, correct = 0, bBoth = 0, bTargetOk = 0, unresolved = 0, uncertainWrong = 0, wrong = 0;
  for (const item of run.aiItems) {
    const lab = labels.get(key(item.term, item.campaign, item.adGroup));
    if (!lab) continue;
    const c = run.ai.results[item.id];
    const got = c ? c.category : "unresolved";
    if (!c) unresolved++;
    compared++;
    confusion[lab.expected] ??= {};
    confusion[lab.expected][got] = (confusion[lab.expected][got] || 0) + 1;
    if (got === lab.expected) {
      correct++;
      if (got === "B" && lab.expectedTarget) {
        bBoth++;
        if (groupById[c.target]?.adGroup === lab.expectedTarget) bTargetOk++;
        else disagreements.push({ term: item.term, adGroup: item.adGroup, expected: `B -> ${lab.expectedTarget}`, got: `B -> ${groupById[c.target]?.adGroup}`, reason: c.reason });
      }
    } else {
      wrong++;
      if (c?.uncertain) uncertainWrong++;
      disagreements.push({ term: item.term, adGroup: item.adGroup, expected: lab.expected, got, reason: c?.reason ?? "" });
    }
  }
  return {
    labelled: labels.size, compared, correct, accuracy: compared ? correct / compared : null,
    confusion, unresolved,
    bTarget: { checked: bBoth, correct: bTargetOk },
    // How useful the "uncertain" flag is: of the wrong answers, how many were flagged?
    wrongFlaggedUncertain: { wrong, flagged: uncertainWrong },
    disagreements,
  };
}

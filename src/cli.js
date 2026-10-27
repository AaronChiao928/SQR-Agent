// Command line.
//   node src/cli.js parity          Compare the code version of the old Excel template with the sheet
//   node src/cli.js check <file>    Run the input checks on a search terms report export
//   node src/cli.js rules <file> [profile.json]   Input checks + rule layer, print the suggestions
//   node src/cli.js diff            Old template vs new rule layer -> docs/reports/legacy-vs-new.md
//   node src/cli.js classify <file> [profile.json]   Rules + AI step (needs ANTHROPIC_API_KEY) -> runs/<time>.json
//   node src/cli.js eval-template <file> <out.csv>   Labels file for the analyst (one line per AI item)
//   node src/cli.js eval <run.json> <labels.csv>     AI accuracy against the analyst's labels
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { legacyRow } from "./legacy.js";
import { loadSearchTermsReport, InputError } from "./input.js";
import { loadProfile, ProfileError } from "./profile.js";
import { applyRules } from "./rules.js";
import { diffLegacyVsNew, renderDiffMarkdown } from "./diff.js";
import { prepareAiItems, runClassification, translationProposals, DEFAULT_MODEL } from "./classify.js";
import { buildReviewItems } from "./suggest.js";
import { createClient } from "../shared/llm.js";
import { labelsTemplate, readLabels, evaluate } from "./eval.js";

const DEFAULT_PROFILE = new URL("../profiles/dewalt.json", import.meta.url);
const readProfile = (path) => loadProfile(JSON.parse(readFileSync(path || DEFAULT_PROFILE, "utf8")));

const [cmd, arg, arg2] = process.argv.slice(2);

function parity() {
  const fx = JSON.parse(readFileSync(new URL("../data/legacy/nl-snapshot.json", import.meta.url), "utf8"));
  const ctx = { brandPattern: fx.brandPattern, competitorPattern: fx.competitorPattern, existingKeywords: fx.existingKeywords };
  const cols = ["E", "G", "H", "I"];
  const diff = [];
  for (const r of fx.rows) {
    const got = legacyRow(r, ctx);
    for (const c of cols) if (got[c] !== r.expected[c]) diff.push({ row: r.excelRow, col: c, sheet: r.expected[c], code: got[c] });
  }
  const variants = {};
  for (const r of fx.rows) for (const k of ["formulaG", "formulaI"]) variants[`${k}: ${r[k]}`] = (variants[`${k}: ${r[k]}`] || 0) + 1;

  console.log(`Source: ${fx.source}`);
  console.log(`Rows compared: ${fx.rows.length}   Cells compared: ${fx.rows.length * cols.length}`);
  console.log(`Formula versions found in the sheet:`);
  for (const [k, n] of Object.entries(variants)) console.log(`  ${k.padEnd(36)} ${n} rows`);
  console.log(diff.length ? `MISMATCHES: ${diff.length}` : `Result: identical to the sheet (0 mismatches)`);
  for (const d of diff.slice(0, 20)) console.log(`  row ${d.row} col ${d.col}: sheet=${d.sheet} code=${d.code}`);
  process.exitCode = diff.length ? 1 : 0;
}

function check(file) {
  if (!file) throw new InputError("Usage: node src/cli.js check <export.csv>");
  const res = loadSearchTermsReport(readFileSync(file));
  console.log(`Header found on line ${res.meta.headerLine} (separator: ${JSON.stringify(res.meta.separator)})`);
  console.log(`Rows kept: ${res.rows.length}   Rows set aside: ${res.excluded.length}`);
  for (const i of res.issues) console.log(`  [${i.level}] ${i.message}`);
  for (const e of res.excluded.slice(0, 20)) console.log(`  set aside, line ${e.line}: ${e.reason} "${e.searchTerm}"`);
}

function rules(file, profilePath) {
  if (!file) throw new InputError("Usage: node src/cli.js rules <export.csv> [profile.json]");
  const profile = readProfile(profilePath);
  const input = loadSearchTermsReport(readFileSync(file));
  const res = applyRules(input.rows, profile);
  const byId = Object.fromEntries(input.rows.map((r) => [r.id, r]));
  const routes = { rules: 0, ai: 0, not_processed: 0 };
  for (const r of res.rows) routes[r.route]++;
  console.log(`Profile: ${profile.brand}   Rows: ${input.rows.length}`);
  console.log(`  handled by rules: ${routes.rules}   sent to AI: ${routes.ai}   not processed: ${routes.not_processed}`);
  console.log(`\nNegative suggestions (${res.negatives.length}, each needs approval):`);
  for (const n of res.negatives) {
    const where = n.level === "shared_list" ? `shared list "${n.target}"` : `ad group ${n.target}`;
    const ev = n.evidence.map((e) => `${e.category}: ${e.term} (${e.mode})`).join("; ");
    console.log(`  ${n.id.padEnd(4)} ${JSON.stringify(n.text).padEnd(22)} ${n.matchType}  -> ${where}  [${ev}]  rows: ${n.sourceRowIds.length}${n.looseMatch ? "  (loose match)" : ""}`);
  }
  if (res.flags.length) {
    console.log(`\nFlags for disabled rules (${res.flags.length}, user decides):`);
    for (const f of res.flags) console.log(`  ${f.id} ${f.category}: ${f.triggers.join(", ")}  "${byId[f.rowId].searchTerm}"`);
  }
  if (res.notProcessed.length) {
    console.log(`\nNot processed (${res.notProcessed.length}):`);
    for (const x of res.notProcessed.slice(0, 20)) console.log(`  ${x.reason}: "${byId[x.rowId].searchTerm}" (${x.campaign})`);
  }
}

function diff() {
  const fx = JSON.parse(readFileSync(new URL("../data/legacy/nl-snapshot.json", import.meta.url), "utf8"));
  const d = diffLegacyVsNew(fx, readProfile());
  const md = renderDiffMarkdown(d, "`data/legacy/nl-snapshot.json` with `profiles/dewalt.json`");
  mkdirSync(new URL("../docs/reports/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../docs/reports/legacy-vs-new.md", import.meta.url), md);
  console.log(`Rows compared: ${d.rowsCompared}   classified differently: ${d.changes.length}`);
  for (const [k, v] of Object.entries(d.counts)) console.log(`  ${k.padEnd(24)} ${v}`);
  console.log("Written: docs/reports/legacy-vs-new.md");
}

async function classify(file, profilePath) {
  if (!file) throw new InputError("Usage: node src/cli.js classify <export.csv> [profile.json]");
  const profile = readProfile(profilePath);
  const input = loadSearchTermsReport(readFileSync(file));
  const rules = applyRules(input.rows, profile);
  const { items, adGroups } = prepareAiItems(input.rows, rules);
  console.log(`Rows: ${input.rows.length}   handled by rules: ${input.rows.length - rules.aiQueue.length - rules.notProcessed.length}   AI items (unique): ${items.length}   model: ${DEFAULT_MODEL}`);
  const client = createClient({ apiKey: process.env.ANTHROPIC_API_KEY });
  const ai = await runClassification({
    items, adGroups, profile, client,
    onLog: (e) => e.event === "batch" && console.log(`  ${e.market} attempt ${e.attempt}: sent ${e.sent}, accepted ${e.accepted}, invalid ${e.invalid.length}, missing ${e.missing.length}`),
  });
  ai.proposals.push(...translationProposals(items, ai.results, profile));
  const review = buildReviewItems({ inputRows: input.rows, rules, ai, aiItems: items, adGroups, profile });
  const counts = {};
  for (const i of review) counts[`${i.kind}/${i.category}`] = (counts[`${i.kind}/${i.category}`] || 0) + 1;
  console.log("Review items (all undecided):");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(28)} ${v}`);
  mkdirSync("runs", { recursive: true });
  const out = `runs/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify({ profile: profile.brand, input: { rows: input.rows, issues: input.issues, excluded: input.excluded }, rules, aiItems: items, adGroups, ai, review }, null, 1));
  console.log(`Written: ${out}`);
}

function evalTemplate(file, out) {
  if (!file || !out) throw new InputError("Usage: node src/cli.js eval-template <export.csv> <out.csv>");
  const profile = readProfile();
  const input = loadSearchTermsReport(readFileSync(file));
  const { items } = prepareAiItems(input.rows, applyRules(input.rows, profile));
  // For the demo data, add the template's Google Translate output as a reading aid.
  let help = null;
  try {
    const fx = JSON.parse(readFileSync(new URL("../data/legacy/nl-snapshot.json", import.meta.url), "utf8"));
    help = Object.fromEntries(fx.rows.filter((r) => r.searchTerm).map((r) => [r.searchTerm.toLowerCase(), r.translation]));
  } catch { /* no reference translations available */ }
  writeFileSync(out, labelsTemplate(items, help));
  console.log(`${items.length} items -> ${out}`);
}

function evalRun(runFile, labelsFile) {
  if (!runFile || !labelsFile) throw new InputError("Usage: node src/cli.js eval <run.json> <labels.csv>");
  const run = JSON.parse(readFileSync(runFile, "utf8"));
  const { labels, problems } = readLabels(readFileSync(labelsFile));
  for (const p of problems) console.log(`  [labels] ${p}`);
  const e = evaluate(run, labels);
  const pct = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  console.log(`Labelled: ${e.labelled}   compared: ${e.compared}   correct: ${e.correct}   accuracy: ${pct(e.accuracy)}   unresolved: ${e.unresolved}`);
  console.log(`B target ad group correct: ${e.bTarget.correct}/${e.bTarget.checked}`);
  console.log(`Wrong answers flagged as uncertain: ${e.wrongFlaggedUncertain.flagged}/${e.wrongFlaggedUncertain.wrong}`);
  console.log("Confusion (expected -> got):");
  for (const [exp, row] of Object.entries(e.confusion)) console.log(`  ${exp}: ${JSON.stringify(row)}`);
  for (const d of e.disagreements) console.log(`  "${d.term}" (${d.adGroup}): expected ${d.expected}, got ${d.got}. ${d.reason}`);
}

try {
  if (cmd === "parity") parity();
  else if (cmd === "check") check(arg);
  else if (cmd === "rules") rules(arg, arg2);
  else if (cmd === "diff") diff();
  else if (cmd === "classify") await classify(arg, arg2);
  else if (cmd === "eval-template") evalTemplate(arg, arg2);
  else if (cmd === "eval") evalRun(arg, arg2);
  else console.log("Commands: parity | check | rules | diff | classify | eval-template | eval");
} catch (e) {
  if (e instanceof InputError) { console.error(`Input problem: ${e.message}`); process.exitCode = 2; }
  else if (e instanceof ProfileError) { console.error(e.message); process.exitCode = 2; }
  else { console.error(process.env.DEBUG ? e : `Error: ${e.message}`); process.exitCode = 1; }
}

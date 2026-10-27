// Evaluation harness tests (synthetic run and labels).
import { test } from "node:test";
import assert from "node:assert/strict";
import { labelsTemplate, readLabels, evaluate } from "../src/eval.js";

const run = {
  adGroups: [{ id: "G1", adGroup: "saws" }, { id: "G2", adGroup: "drills" }],
  aiItems: [
    { id: "T1", term: "cirkelzaag", campaign: "C", adGroup: "saws" },
    { id: "T2", term: "klopboormachine", campaign: "C", adGroup: "saws" },
    { id: "T3", term: "gereedschap", campaign: "C", adGroup: "saws" },
    { id: "T4", term: "vacature", campaign: "C", adGroup: "saws" },
    { id: "T5", term: "not labelled", campaign: "C", adGroup: "saws" },
  ],
  ai: { results: {
    T1: { category: "A", uncertain: false },
    T2: { category: "B", target: "G2", uncertain: false },
    T3: { category: "D", uncertain: true, reason: "r" },
  } },
};

test("template lists every AI item once with empty label columns", () => {
  const t = labelsTemplate(run.aiItems);
  assert.equal(t.trim().split("\r\n").length, 6);
  assert.match(t, /^Search term,Campaign,Ad group,Expected category,Expected target ad group,Note/);
});

test("evaluation: accuracy, confusion, B targets, unresolved and the value of the uncertain flag", () => {
  const csv = [
    "Search term,Campaign,Ad group,Expected category,Expected target ad group,Note",
    "cirkelzaag,C,saws,A,,",
    "klopboormachine,C,saws,B,drills,",
    "gereedschap,C,saws,C,,",
    "vacature,C,saws,D,,",
    "not labelled,C,saws,,,",
  ].join("\n");
  const { labels, problems } = readLabels(csv);
  assert.deepEqual(problems, []);
  assert.equal(labels.size, 4); // unlabelled rows are left out, not counted as wrong
  const e = evaluate(run, labels);
  assert.equal(e.compared, 4);
  assert.equal(e.correct, 2);
  assert.equal(e.accuracy, 0.5);
  assert.deepEqual(e.confusion.C, { D: 1 });
  assert.deepEqual(e.confusion.D, { unresolved: 1 });
  assert.deepEqual(e.bTarget, { checked: 1, correct: 1 });
  assert.deepEqual(e.wrongFlaggedUncertain, { wrong: 2, flagged: 1 });
});

test("invalid labels are reported, not guessed", () => {
  const { problems } = readLabels("Search term,Campaign,Ad group,Expected category\nx,C,A,maybe\n");
  assert.equal(problems.length, 1);
});

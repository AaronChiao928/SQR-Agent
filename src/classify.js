// Step 3: the AI classifies the terms the rules did not handle, and code verifies every answer.
//
// 1. Prepare: one item per unique (search term, campaign, ad group), IDs T1, T2, ...
//    Ad groups get IDs G1, G2, ... The AI may only refer to these IDs.
// 2. Ask: one structured request per batch, per market. Not an agent loop: the task has a
//    fixed input and output, so extra tool rounds would add uncertainty, not accuracy.
// 3. Verify (code): every item answered exactly once; no unknown IDs; category is A–D;
//    B has a target that exists, is in the same market and is not the current ad group;
//    reason and translation are present. List proposals must name text that really
//    appears in the search terms. Anything that fails is set aside, never used.
// 4. Retry once for missing or invalid items. Whatever is still unresolved goes to the
//    user as "AI could not classify", to be decided like category C.
// 5. Translation check (code, D19): if the translation hits a list but the original did not,
//    propose adding the local spelling; never negate on the strength of a translation.

import { responseText, parseJson } from "../shared/llm.js";
import { buildMatcher } from "../shared/match.js";
import { CATEGORIES } from "./profile.js";
import { classifySystemPrompt, classifyUserMessage, CLASSIFY_PROMPT_VERSION } from "./prompts.js";

export const DEFAULT_MODEL = (typeof process !== "undefined" && process.env?.CLAUDE_MODEL) || "claude-sonnet-5-5";
export const BATCH_SIZE = 40;
const AI_CATEGORIES = ["A", "B", "C", "D"];
const LISTS = ["brand", "competitor", "retailer"];

/** Build the AI's input from the input rows and the rule layer's result. */
export function prepareAiItems(inputRows, rulesResult) {
  const route = Object.fromEntries(rulesResult.rows.map((r) => [r.id, r]));
  const groups = new Map(); // ad group id by "market|campaign|adGroup"
  const adGroups = [];
  const gid = (market, campaign, adGroup) => {
    const k = [market, campaign, adGroup].join("\u0000");
    if (!groups.has(k)) {
      const g = { id: `G${adGroups.length + 1}`, market, campaign, adGroup };
      groups.set(k, g.id);
      adGroups.push(g);
    }
    return groups.get(k);
  };
  // Every in-scope ad group in the report is a candidate target, including those whose terms all went to rules.
  for (const row of inputRows) {
    const r = route[row.id];
    if (r && r.route !== "not_processed") gid(r.market, row.campaign, row.adGroup);
  }
  const items = [];
  const byKey = new Map();
  for (const row of inputRows) {
    const r = route[row.id];
    if (r?.route !== "ai") continue;
    const key = [r.market, row.searchTerm.toLowerCase(), row.campaign, row.adGroup].join("\u0000");
    if (byKey.has(key)) { byKey.get(key).rowIds.push(row.id); continue; }
    const item = { id: `T${items.length + 1}`, term: row.searchTerm, market: r.market, campaign: row.campaign, adGroup: row.adGroup, adGroupId: gid(r.market, row.campaign, row.adGroup), rowIds: [row.id] };
    byKey.set(key, item);
    items.push(item);
  }
  return { items, adGroups };
}

/**
 * Check one model answer against the batch. Pure function: no model calls.
 * Returns { accepted: {id: classification}, invalid: [{id, problem}], missing: [ids], unknown: [ids], proposals, rejectedProposals }
 */
export function verifyAnswer(answer, batch, adGroups) {
  const byId = Object.fromEntries(batch.map((i) => [i.id, i]));
  const groupById = Object.fromEntries(adGroups.map((g) => [g.id, g]));
  const accepted = {}, invalid = [], unknown = [], seen = new Map();
  const list = Array.isArray(answer?.classifications) ? answer.classifications : [];

  for (const c of list) seen.set(String(c?.id), (seen.get(String(c?.id)) || 0) + 1);
  for (const c of list) {
    const id = String(c?.id);
    const item = byId[id];
    if (!item) { unknown.push(id); continue; }
    if (seen.get(id) > 1) { if (!invalid.some((x) => x.id === id)) invalid.push({ id, problem: "answered more than once" }); continue; }
    const problems = [];
    if (!AI_CATEGORIES.includes(c.category)) problems.push(`category must be A, B, C or D (got ${JSON.stringify(c.category)})`);
    if (!String(c.reason ?? "").trim()) problems.push("missing reason");
    if (!String(c.translation ?? "").trim()) problems.push("missing translation");
    if (typeof c.uncertain !== "boolean") problems.push("uncertain must be true or false");
    const t = c.target_ad_group_id;
    if (c.category === "B") {
      const g = groupById[t];
      if (!g) problems.push(`target ${JSON.stringify(t)} is not an ad group in the report`);
      else if (g.market !== item.market) problems.push(`target ${t} is in another market`);
      else if (t === item.adGroupId) problems.push("target is the current ad group");
    } else if (t != null) problems.push(`category ${c.category} must not have a target`);
    if (problems.length) invalid.push({ id, problem: problems.join("; ") });
    else accepted[id] = { id, category: c.category, target: c.category === "B" ? t : null, uncertain: c.uncertain, reason: String(c.reason).trim(), translation: String(c.translation).trim(), language: String(c.language ?? "").trim() };
  }
  const missing = batch.map((i) => i.id).filter((id) => !seen.has(id));

  // List proposals: the name must actually appear in one of the cited search terms.
  const proposals = [], rejectedProposals = [];
  for (const p of Array.isArray(answer?.list_proposals) ? answer.list_proposals : []) {
    const term = String(p?.term ?? "").trim();
    const ids = (Array.isArray(p?.item_ids) ? p.item_ids : []).map(String).filter((id) => byId[id]);
    const found = ids.filter((id) => byId[id].term.toLowerCase().includes(term.toLowerCase()));
    if (!LISTS.includes(p?.list)) rejectedProposals.push({ ...p, problem: "unknown list" });
    else if (!term) rejectedProposals.push({ ...p, problem: "empty term" });
    else if (!found.length) rejectedProposals.push({ ...p, problem: "term does not appear in the cited search terms" });
    else proposals.push({ list: p.list, term: term.toLowerCase(), itemIds: found, reason: String(p.reason ?? "").trim(), source: "ai" });
  }
  return { accepted, invalid, missing, unknown, proposals, rejectedProposals };
}

async function ask(client, model, system, user) {
  const res = await client.messages.create({ model, max_tokens: 8000, system, messages: [{ role: "user", content: user }] });
  return parseJson(responseText(res));
}

/**
 * Run the AI step. `client` is injected (real API client or a test fake).
 * Returns { results: {itemId: classification}, unresolved: [{id, problem}], proposals, log }
 */
export async function runClassification({ items, adGroups, profile, client, model = DEFAULT_MODEL, batchSize = BATCH_SIZE, onLog = () => {} }) {
  const results = {}, unresolved = [], proposals = [], log = [];
  const note = (entry) => { log.push(entry); onLog(entry); };
  note({ event: "start", model, promptVersion: CLASSIFY_PROMPT_VERSION, items: items.length, adGroups: adGroups.length });

  const markets = [...new Set(items.map((i) => i.market))];
  for (const market of markets) {
    const system = classifySystemPrompt(profile, market);
    const groups = adGroups.filter((g) => g.market === market);
    const all = items.filter((i) => i.market === market);
    for (let b = 0; b < all.length; b += batchSize) {
      let todo = all.slice(b, b + batchSize);
      for (let attempt = 1; attempt <= 2 && todo.length; attempt++) {
        let answer;
        try { answer = await ask(client, model, system, classifyUserMessage(todo, groups)); }
        catch (e) {
          note({ event: "error", market, attempt, items: todo.length, message: e.message });
          if (attempt === 2) for (const i of todo) unresolved.push({ id: i.id, problem: `model call failed: ${e.message}` });
          continue;
        }
        const v = verifyAnswer(answer, todo, groups);
        Object.assign(results, v.accepted);
        proposals.push(...v.proposals);
        note({ event: "batch", market, attempt, sent: todo.length, accepted: Object.keys(v.accepted).length, invalid: v.invalid, missing: v.missing, unknownIds: v.unknown, rejectedProposals: v.rejectedProposals });
        const retry = new Set([...v.missing, ...v.invalid.map((x) => x.id)]);
        if (attempt === 2) {
          for (const x of v.invalid) unresolved.push(x);
          for (const id of v.missing) unresolved.push({ id, problem: "not answered by the model" });
        }
        todo = todo.filter((i) => retry.has(i.id));
      }
    }
  }
  note({ event: "end", classified: Object.keys(results).length, unresolved: unresolved.length, proposals: proposals.length });
  return { results, unresolved, proposals: mergeProposals(proposals), log };
}

/** D19: translation hits a list but the original term did not -> propose a local spelling. Code only. */
export function translationProposals(items, results, profile) {
  const out = [];
  for (const cat of CATEGORIES) {
    const m = buildMatcher(profile.lists[cat]);
    for (const item of items) {
      const tr = results[item.id]?.translation;
      if (!tr) continue;
      for (const h of m(tr, item.market)) {
        out.push({ list: cat, term: null, itemIds: [item.id], source: "translation", reason: `Translation "${tr}" matches list entry "${h.entry.term}", but the original "${item.term}" does not. Add the original spelling to the list if it is the same name.` });
      }
    }
  }
  return out;
}

function mergeProposals(ps) {
  const m = new Map();
  for (const p of ps) {
    const k = `${p.list}\u0000${p.term}`;
    if (!m.has(k)) m.set(k, { ...p, itemIds: [...p.itemIds] });
    else for (const id of p.itemIds) if (!m.get(k).itemIds.includes(id)) m.get(k).itemIds.push(id);
  }
  return [...m.values()];
}

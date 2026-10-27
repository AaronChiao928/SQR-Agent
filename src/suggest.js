// Turn the rule layer's output and the verified AI classifications into review items.
// Nothing here is final: every item waits for a person's decision (step 4).
//
// Item kinds:
//   negative   add a negative keyword            (rules: brand/competitor/retailer; AI: D)
//   keyword    add a new keyword                 (AI: A)
//   move       negative here + keyword elsewhere (AI: B, approved or rejected as one)
//   decide     the user chooses an option        (AI: C; disabled rule categories; AI could not classify)
//   list       add a term to a profile list      (AI proposals; translation hits)

import { buildMatcher } from "../shared/match.js";
import { sharedListFor } from "./rules.js";

export function buildReviewItems({ inputRows, rules, ai, aiItems, adGroups, profile }) {
  const rowById = Object.fromEntries(inputRows.map((r) => [r.id, r]));
  const itemById = Object.fromEntries(aiItems.map((i) => [i.id, i]));
  const groupById = Object.fromEntries(adGroups.map((g) => [g.id, g]));
  const R = profile.rules;
  const out = [];
  const keyed = new Map();
  const push = (key, item) => {
    if (key && keyed.has(key)) {
      const ex = keyed.get(key);
      for (const id of item.rowIds) if (!ex.rowIds.includes(id)) ex.rowIds.push(id);
      return ex;
    }
    const it = { id: `I${out.length + 1}`, decision: null, ...item };
    out.push(it);
    if (key) keyed.set(key, it);
    return it;
  };
  const negTarget = (spec, row, market) =>
    spec.level === "shared_list"
      ? { level: "shared_list", list: sharedListFor(market, profile) }
      : { level: "ad_group", campaign: row.campaign, adGroup: row.adGroup };

  // Rule-based negatives (already de-duplicated by the rule layer)
  for (const n of rules.negatives) {
    push(null, {
      kind: "negative", origin: "rule", category: n.categories.join("+"), text: n.text, matchType: n.matchType,
      target: n.level === "shared_list" ? { level: "shared_list", list: n.target } : { level: "ad_group", campaign: n.campaign, adGroup: n.adGroup },
      rowIds: [...n.sourceRowIds],
      reason: n.evidence.map((e) => `Matches ${e.category} list entry "${e.term}" (${e.mode})`).join("; "),
      looseMatch: n.looseMatch,
    });
  }
  // Disabled rule categories: the user decides (D23)
  for (const f of rules.flags) {
    push(null, { kind: "decide", origin: "rule", category: f.category, text: rowById[f.rowId].searchTerm.toLowerCase(), rowIds: [f.rowId],
      reason: `Matches the ${f.category} list (${f.triggers.join(", ")}), but this rule is switched off in the profile`,
      options: R.C.options, allowBulk: R.C.allowBulk, campaign: rowById[f.rowId].campaign, adGroup: rowById[f.rowId].adGroup, market: rules.rows.find((x) => x.id === f.rowId).market });
  }

  // AI classifications
  for (const item of aiItems) {
    const c = ai.results[item.id];
    const row = rowById[item.rowIds[0]];
    const base = { origin: "ai", text: item.term.toLowerCase(), rowIds: [...item.rowIds], aiItemId: item.id };
    if (!c) {
      const u = ai.unresolved.find((x) => x.id === item.id);
      push(null, { ...base, kind: "decide", category: "unclassified", reason: `AI could not classify: ${u?.problem ?? "no answer"}`,
        options: R.C.options, allowBulk: R.C.allowBulk, campaign: item.campaign, adGroup: item.adGroup, market: item.market });
      continue;
    }
    const ai_ = { translation: c.translation, language: c.language, uncertain: c.uncertain, reason: c.reason };
    if (c.category === "A") {
      if (!R.A.addKeyword) continue;
      push(`K|${item.campaign}|${item.adGroup}|${base.text}`, { ...base, ...ai_, kind: "keyword", category: "A", campaign: item.campaign, adGroup: item.adGroup, matchTypes: R.A.keywordMatchTypes });
    } else if (c.category === "B") {
      const g = groupById[c.target];
      push(`M|${item.campaign}|${item.adGroup}|${g.campaign}|${g.adGroup}|${base.text}`, {
        ...base, ...ai_, kind: "move", category: "B",
        negative: { text: base.text, matchType: R.B.negative.matchType, target: negTarget(R.B.negative, row, item.market) },
        keyword: R.B.addKeyword ? { text: base.text, campaign: g.campaign, adGroup: g.adGroup, matchTypes: R.B.keywordMatchTypes } : null,
        from: { campaign: item.campaign, adGroup: item.adGroup },
      });
    } else if (c.category === "C") {
      push(null, { ...base, ...ai_, kind: "decide", category: "C", options: R.C.options, allowBulk: R.C.allowBulk, campaign: item.campaign, adGroup: item.adGroup, market: item.market });
    } else if (c.category === "D") {
      const t = negTarget(R.D.negative, row, item.market);
      push(`N|${JSON.stringify(t)}|${base.text}`, { ...base, ...ai_, kind: "negative", category: "D", text: base.text, matchType: R.D.negative.matchType, target: t });
    }
  }

  // List proposals: drop names the lists already cover; keep the rest for approval.
  const matchers = Object.fromEntries(["brand", "competitor", "retailer"].map((c) => [c, buildMatcher(profile.lists[c])]));
  for (const p of ai.proposals) {
    const market = itemById[p.itemIds[0]]?.market;
    if (p.term && matchers[p.list](p.term, market).length) continue;
    push(`L|${p.list}|${p.term ?? p.reason}`, { kind: "list", origin: p.source, category: p.list, text: p.term, rowIds: p.itemIds.flatMap((id) => itemById[id]?.rowIds ?? []), reason: p.reason, needsTerm: !p.term });
  }
  return out;
}

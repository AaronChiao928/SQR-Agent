// Step 2: the rule layer. Deterministic: the same report and profile always give the same result.
//
// For every row:
//   1. Scope: is the campaign a type this version processes (generic), and is its market known?
//      Rows out of scope get no suggestions and are listed as "not processed" (D1).
//   2. Lists: match the ORIGINAL search term against the brand, competitor and retailer lists (D18).
//   3. Route:
//      - a hit in an enabled category      -> negative suggestion(s), one per triggering word (D8, D10)
//      - a hit in a disabled category      -> flag for the user to decide, like category C (D23)
//      - no hit                            -> sent to the AI in step 3
//      Rows with any hit are never sent to the AI, so the AI cannot override a rule.

import { buildMatcher } from "../shared/match.js";
import { CATEGORIES } from "./profile.js";

/** Campaign type and market from the campaign name, using the profile's patterns. */
export function classifyCampaign(campaign, profile) {
  const c = profile.campaigns;
  const type = Object.entries(c.typePatterns).find(([, src]) => new RegExp(src, "u").test(campaign))?.[0] ?? null;
  const m = new RegExp(c.marketPattern, "u").exec(campaign);
  return { type, market: m ? m[1].toLowerCase() : null };
}

export function sharedListFor(market, profile) {
  return profile.sharedNegativeLists.find((l) => l.markets.includes(market))?.name ?? null;
}

export function applyRules(rows, profile) {
  const matchers = Object.fromEntries(CATEGORIES.map((c) => [c, buildMatcher(profile.lists[c])]));
  const out = { rows: [], negatives: [], flags: [], aiQueue: [], notProcessed: [] };
  const negIndex = new Map();

  const addNegative = (spec, row, evidence) => {
    const key = [spec.level, spec.target, spec.matchType, spec.text].join("\u0000");
    let n = negIndex.get(key);
    if (!n) {
      n = { id: `N${out.negatives.length + 1}`, ...spec, categories: [], sourceRowIds: [], evidence: [] };
      negIndex.set(key, n);
      out.negatives.push(n);
    }
    if (!n.categories.includes(evidence.category)) n.categories.push(evidence.category);
    if (!n.sourceRowIds.includes(row.id)) n.sourceRowIds.push(row.id);
    if (!n.evidence.some((e) => e.term === evidence.term && e.category === evidence.category)) n.evidence.push(evidence);
  };

  for (const row of rows) {
    const { type, market } = classifyCampaign(row.campaign, profile);
    const r = { id: row.id, campaignType: type, market, hits: [], route: null };
    out.rows.push(r);

    let reason = null;
    if (!type) reason = "CAMPAIGN_TYPE_UNKNOWN";
    else if (!profile.campaigns.processedTypes.includes(type)) reason = "CAMPAIGN_TYPE_NOT_PROCESSED";
    else if (!market) reason = "MARKET_UNKNOWN";
    if (reason) {
      r.route = "not_processed";
      out.notProcessed.push({ rowId: row.id, reason, campaign: row.campaign });
      continue;
    }

    for (const cat of CATEGORIES) {
      for (const h of matchers[cat](row.searchTerm, market)) {
        r.hits.push({ category: cat, term: h.entry.term, mode: h.entry.mode, matched: h.matched, trigger: h.trigger, spaceless: h.spaceless });
      }
    }
    if (!r.hits.length) { r.route = "ai"; out.aiQueue.push(row.id); continue; }

    r.route = "rules";
    const disabled = new Map();
    for (const h of r.hits) {
      const s = profile.rules[h.category];
      if (!s.enabled) {
        if (!disabled.has(h.category)) disabled.set(h.category, new Set());
        disabled.get(h.category).add(h.trigger);
        continue;
      }
      let target;
      if (s.level === "shared_list") {
        target = sharedListFor(market, profile);
        if (!target) {
          out.notProcessed.push({ rowId: row.id, reason: "NO_SHARED_LIST_FOR_MARKET", campaign: row.campaign, market });
          continue;
        }
      } else target = `${row.campaign} > ${row.adGroup}`;
      addNegative(
        {
          level: s.level,
          target,
          campaign: s.level === "ad_group" ? row.campaign : null,
          adGroup: s.level === "ad_group" ? row.adGroup : null,
          matchType: s.matchType,
          text: s.negativeForm === "trigger" ? h.trigger : row.searchTerm.toLowerCase(),
          looseMatch: h.spaceless,
        },
        row,
        { category: h.category, term: h.term, mode: h.mode }
      );
    }
    for (const [category, triggers] of disabled) {
      out.flags.push({ id: `F${out.flags.length + 1}`, rowId: row.id, category, triggers: [...triggers], reason: "RULE_DISABLED" });
    }
  }
  return out;
}

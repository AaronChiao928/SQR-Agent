// Brand profile: everything brand-specific (lists, campaign naming, rule settings).
// The code contains no brand names; switching brand means switching profile.
//
// Settings are closed choices. Anything not listed here is rejected, including
// attempts to configure the fixed safety rules (see FIXED below).

import { compileEntry } from "../shared/match.js";

export const CATEGORIES = ["brand", "competitor", "retailer"];
export const MODES = ["substring", "word", "pattern"];
const NEG_FORMS = ["trigger", "whole_term"];
const LEVELS = ["shared_list", "ad_group"];
const MATCH_TYPES = ["broad", "phrase", "exact"];
const C_OPTIONS = ["negative_ad_group", "negative_shared_list", "keep"];

// Not configurable for any brand. Named here so a profile that tries to set them
// gets a clear explanation instead of a generic "unknown key".
const FIXED = {
  autoApprove: "Every change needs human approval; this cannot be switched off.",
  applyToAccount: "The agent only produces files; it never connects to an ad account.",
  aiOverridesRules: "Terms handled by rules are never sent to the AI.",
  skipVerification: "AI output is always checked by code.",
};

export class ProfileError extends Error {
  constructor(errors) {
    super(`Invalid brand profile:\n- ${errors.join("\n- ")}`);
    this.errors = errors;
  }
}

/** Validate a parsed profile. Returns a list of problems (empty = valid). */
export function validateProfile(p) {
  const errs = [];
  const keys = (obj, allowed, where) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) { errs.push(`${where}: must be an object`); return false; }
    for (const k of Object.keys(obj)) {
      if (k in FIXED) errs.push(`${where}.${k}: not configurable. ${FIXED[k]}`);
      else if (!allowed.includes(k)) errs.push(`${where}.${k}: unknown setting`);
    }
    return true;
  };
  const oneOf = (v, opts, where) => { if (!opts.includes(v)) errs.push(`${where}: must be one of ${opts.join(", ")} (got ${JSON.stringify(v)})`); };
  const bool = (v, where) => { if (typeof v !== "boolean") errs.push(`${where}: must be true or false`); };
  const subset = (v, opts, where) => {
    if (!Array.isArray(v) || !v.length) return errs.push(`${where}: must be a non-empty list`);
    for (const x of v) oneOf(x, opts, where);
    if (new Set(v).size !== v.length) errs.push(`${where}: contains duplicates`);
  };
  const regex = (src, where, groups) => {
    try {
      const re = new RegExp(src, "u");
      if (groups !== undefined && new RegExp(`${src}|`, "u").exec("").length - 1 !== groups)
        errs.push(`${where}: must have exactly ${groups} capture group(s)`);
      return re;
    } catch (e) { errs.push(`${where}: invalid pattern (${e.message})`); }
  };
  const negative = (n, where) => {
    if (!keys(n, ["negativeForm", "level", "matchType"], where)) return;
    oneOf(n.negativeForm, NEG_FORMS, `${where}.negativeForm`);
    oneOf(n.level, LEVELS, `${where}.level`);
    oneOf(n.matchType, MATCH_TYPES, `${where}.matchType`);
  };

  if (!keys(p, ["profileVersion", "brand", "productDomain", "notes", "campaigns", "sharedNegativeLists", "lists", "rules"], "profile"))
    return errs;
  if (p.profileVersion !== 1) errs.push("profileVersion: must be 1");
  if (!p.brand || typeof p.brand !== "string") errs.push("brand: required");
  if (!p.productDomain || typeof p.productDomain !== "string") errs.push("productDomain: required (the AI needs it to judge relevance)");

  // Campaign naming
  if (keys(p.campaigns, ["typePatterns", "processedTypes", "marketPattern"], "campaigns")) {
    const c = p.campaigns;
    if (keys(c.typePatterns, Object.keys(c.typePatterns || {}), "campaigns.typePatterns"))
      for (const [t, src] of Object.entries(c.typePatterns)) regex(src, `campaigns.typePatterns.${t}`);
    subset(c.processedTypes, ["generic"], "campaigns.processedTypes"); // only generic rules exist in this version (D1)
    for (const t of c.processedTypes || []) if (!(t in (c.typePatterns || {}))) errs.push(`campaigns.processedTypes: no pattern defined for "${t}"`);
    regex(c.marketPattern, "campaigns.marketPattern", 1);
  }

  // Shared negative lists: each market in at most one list
  const seenMarket = new Map();
  if (!Array.isArray(p.sharedNegativeLists)) errs.push("sharedNegativeLists: must be a list");
  else p.sharedNegativeLists.forEach((l, i) => {
    const w = `sharedNegativeLists[${i}]`;
    if (!keys(l, ["name", "markets"], w)) return;
    if (!l.name) errs.push(`${w}.name: required`);
    if (!Array.isArray(l.markets) || !l.markets.length) errs.push(`${w}.markets: must be a non-empty list`);
    for (const m of l.markets || []) {
      if (seenMarket.has(m)) errs.push(`${w}: market "${m}" is already in list "${seenMarket.get(m)}"`);
      seenMarket.set(m, l.name);
    }
  });

  // Term lists
  if (keys(p.lists, CATEGORIES, "lists")) {
    for (const cat of CATEGORIES) {
      const list = p.lists[cat];
      if (!Array.isArray(list)) { errs.push(`lists.${cat}: must be a list`); continue; }
      const seen = new Set();
      list.forEach((e, i) => {
        const w = `lists.${cat}[${i}]`;
        if (!keys(e, ["term", "mode", "markets", "note"], w)) return;
        if (!e.term || typeof e.term !== "string") return errs.push(`${w}.term: required`);
        oneOf(e.mode, MODES, `${w}.mode`);
        if (e.markets !== undefined && (!Array.isArray(e.markets) || !e.markets.length)) errs.push(`${w}.markets: must be a non-empty list or left out`);
        const key = `${e.mode}:${e.term.toLowerCase()}`;
        if (seen.has(key)) errs.push(`${w}: duplicate term "${e.term}"`);
        seen.add(key);
        if (MODES.includes(e.mode)) {
          try {
            const { re } = compileEntry(e);
            re.lastIndex = 0;
            if (e.mode === "pattern" && re.test("")) errs.push(`${w}: pattern matches empty text`);
          } catch (x) { errs.push(`${w}: invalid pattern (${x.message})`); }
        }
      });
    }
  }

  // Rule settings
  if (keys(p.rules, [...CATEGORIES, "A", "B", "C", "D"], "rules")) {
    const r = p.rules;
    for (const cat of CATEGORIES) {
      const w = `rules.${cat}`;
      if (!keys(r[cat], ["enabled", "negativeForm", "level", "matchType"], w)) continue;
      bool(r[cat].enabled, `${w}.enabled`);
      negative({ negativeForm: r[cat].negativeForm, level: r[cat].level, matchType: r[cat].matchType }, w);
    }
    if (keys(r.A, ["addKeyword", "keywordMatchTypes"], "rules.A")) {
      bool(r.A.addKeyword, "rules.A.addKeyword");
      subset(r.A.keywordMatchTypes, MATCH_TYPES, "rules.A.keywordMatchTypes");
    }
    if (keys(r.B, ["negative", "addKeyword", "keywordMatchTypes"], "rules.B")) {
      negative(r.B.negative, "rules.B.negative");
      bool(r.B.addKeyword, "rules.B.addKeyword");
      subset(r.B.keywordMatchTypes, MATCH_TYPES, "rules.B.keywordMatchTypes");
    }
    if (keys(r.C, ["options", "matchType", "allowBulk"], "rules.C")) {
      subset(r.C.options, C_OPTIONS, "rules.C.options");
      oneOf(r.C.matchType, MATCH_TYPES, "rules.C.matchType");
      bool(r.C.allowBulk, "rules.C.allowBulk");
    }
    if (keys(r.D, ["negative"], "rules.D")) negative(r.D.negative, "rules.D.negative");
    // The AI does not pick a word out of a term (D15), so AI-based negatives use the whole term.
    for (const c of ["B", "D"]) if (r[c]?.negative && r[c].negative.negativeForm !== "whole_term")
      errs.push(`rules.${c}.negative.negativeForm: must be whole_term (the AI does not pick trigger words)`);

    const usesShared =
      CATEGORIES.some((c) => r[c]?.level === "shared_list") ||
      r.B?.negative?.level === "shared_list" ||
      r.D?.negative?.level === "shared_list" ||
      (r.C?.options || []).includes("negative_shared_list");
    if (usesShared && !(p.sharedNegativeLists || []).length)
      errs.push("sharedNegativeLists: rules send negatives to a shared list, but no shared list is defined");
  }
  return errs;
}

export function loadProfile(obj) {
  const errs = validateProfile(obj);
  if (errs.length) throw new ProfileError(errs);
  return obj;
}

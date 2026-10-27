// Shared: match a text against a list of terms, in any language.
//
// Each list entry has a matching mode:
//   substring  the term may appear inside a longer word ("dewalt" in "mydewalt")
//   word       the term must stand on its own ("beta" matches "beta zaag", not "betaalbare")
//   pattern    a regular expression for a whole word (e.g. model numbers "dch273")
//
// Matching ignores case and works for letters of any alphabet (é, ü, ł, Cyrillic, ...).
// Languages written without spaces (Chinese, Japanese, Thai) have no "whole word":
// for those, word and pattern entries fall back to substring matching and the hit
// is marked `spaceless: true` so the reviewer knows it was a looser match.

const SPACELESS_CLASS = "[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}]";
const SPACELESS = new RegExp(SPACELESS_CLASS, "u");
// A letter or digit that would make a word longer. Characters of space-less scripts do
// not count, so "aeg电钻" still has "aeg" as a whole word.
const WORD_CHAR = `(?:(?!${SPACELESS_CLASS})[\\p{L}\\p{N}])`;
const NOT_BEFORE = `(?<!${WORD_CHAR})`;
const NOT_AFTER = `(?!${WORD_CHAR})`;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const normalize = (s) => String(s ?? "").normalize("NFC");

/** Compile one entry into a regex. Throws on an invalid pattern, so bad lists fail early. */
export function compileEntry(entry) {
  const spaceless = SPACELESS.test(entry.term);
  let body;
  if (entry.mode === "pattern") body = `(?:${entry.term})`;
  else if (entry.mode === "substring" || entry.mode === "word") body = escapeRe(normalize(entry.term));
  else throw new Error(`Unknown matching mode "${entry.mode}" for term "${entry.term}"`);
  const bounded = entry.mode === "substring" || spaceless ? body : NOT_BEFORE + body + NOT_AFTER;
  return { re: new RegExp(bounded, "giu"), spaceless };
}

/**
 * The word to use as a negative keyword for a hit.
 * Google Ads negative keywords match whole words, so a negative "dewalt" would not
 * block the search "mydewalt". The trigger is therefore the whole space-separated
 * word(s) the hit sits in. For languages without spaces, the matched text itself.
 */
export function triggerFor(text, start, end, spaceless) {
  if (spaceless || SPACELESS.test(text.slice(start, end))) return text.slice(start, end).toLowerCase();
  // Expand to the surrounding word; stop at spaces and at characters of space-less scripts.
  const stop = (ch) => /\s/u.test(ch) || SPACELESS.test(ch);
  let s = start, e = end;
  while (s > 0 && !stop(text[s - 1])) s--;
  while (e < text.length && !stop(text[e])) e++;
  return text.slice(s, e).toLowerCase();
}

/**
 * Build a matcher for a list of entries. Entries may carry `markets: [...]`;
 * without it an entry applies in every market.
 * Returns (text, market) => [{ entry, matched, trigger, spaceless }]
 */
export function buildMatcher(entries) {
  const compiled = entries.map((entry) => ({ entry, ...compileEntry(entry) }));
  return (text, market) => {
    const t = normalize(text);
    const hits = [];
    for (const c of compiled) {
      if (c.entry.markets && !c.entry.markets.includes(market)) continue;
      c.re.lastIndex = 0;
      let m;
      while ((m = c.re.exec(t))) {
        if (m[0] === "") { c.re.lastIndex++; continue; }
        const spaceless = c.spaceless || SPACELESS.test(m[0]);
        hits.push({
          entry: c.entry,
          matched: m[0],
          trigger: triggerFor(t, m.index, m.index + m[0].length, spaceless),
          spaceless,
        });
      }
    }
    return hits;
  };
}

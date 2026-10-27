// Matching tests on constructed examples in several languages.
// These are not real search terms; they check the matching behaviour only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMatcher } from "../shared/match.js";

const triggers = (entries, text, market) => buildMatcher(entries)(text, market).map((h) => h.trigger);
const MODEL = { term: "d[cw]\\p{L}*\\d[\\p{L}\\p{N}]*", mode: "pattern" };

test("case does not matter", () => {
  assert.deepEqual(triggers([{ term: "dewalt", mode: "substring" }], "DeWALT boormachine"), ["dewalt"]);
  assert.deepEqual(triggers([{ term: "makita", mode: "substring" }], "MAKITA accu"), ["makita"]);
});

test("substring mode catches compounds, and the trigger is the whole word (Google negatives match whole words)", () => {
  assert.deepEqual(triggers([{ term: "dewalt", mode: "substring" }], "mydewalt login"), ["mydewalt"]);
  assert.deepEqual(triggers([{ term: "bosch", mode: "substring" }], "boschhamer kopen"), ["boschhamer"]);
});

test("word mode does not match inside longer words", () => {
  assert.deepEqual(triggers([{ term: "beta", mode: "word" }], "betaalbare boormachine"), []); // Dutch
  assert.deepEqual(triggers([{ term: "beta", mode: "word" }], "beta zaag"), ["beta"]);
  assert.deepEqual(triggers([{ term: "skil", mode: "word" }], "skill saw"), []);
  assert.deepEqual(triggers([{ term: "brico", mode: "word" }], "outils bricolage"), []); // French
  assert.deepEqual(triggers([{ term: "brico", mode: "word" }], "brico plan-it boormachine"), ["brico"]);
});

test("word boundaries understand accented letters (plain \\b would get these wrong)", () => {
  // French "fermé" (closed): a plain ASCII \b would treat é as a boundary and match "ferm".
  assert.deepEqual(triggers([{ term: "ferm", mode: "word" }], "magasin fermé"), []);
  assert.deepEqual(triggers([{ term: "ferm", mode: "word" }], "ferm schuurmachine"), ["ferm"]);
  // German and Polish letters next to a term
  assert.deepEqual(triggers([{ term: "aeg", mode: "word" }], "aegäre"), []);
  assert.deepEqual(triggers([{ term: "makita", mode: "word" }], "wkrętarka makita"), ["makita"]);
});

test("other alphabets: Cyrillic and Greek", () => {
  assert.deepEqual(triggers([{ term: "макита", mode: "word" }], "шуруповерт Макита"), ["макита"]);
  assert.deepEqual(triggers([{ term: "μακίτα", mode: "word" }], "δράπανο μακίτα"), ["μακίτα"]);
});

test("languages without spaces fall back to substring and are marked as loose matches", () => {
  const m = buildMatcher([{ term: "マキタ", mode: "word" }]);
  const hits = m("マキタドリル");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].trigger, "マキタ");
  assert.equal(hits[0].spaceless, true);
  // A Latin term written next to Chinese characters is still a whole word
  assert.deepEqual(triggers([{ term: "aeg", mode: "word" }], "aeg电钻"), ["aeg"]);
});

test("decomposed accents are normalised before matching", () => {
  const decomposed = "ferme\u0301"; // "fermé" typed as e + combining accent
  assert.deepEqual(triggers([{ term: "ferm", mode: "word" }], decomposed), []);
});

test("model-number pattern returns the whole model number", () => {
  assert.deepEqual(triggers([MODEL], "dcmht564n"), ["dcmht564n"]);
  assert.deepEqual(triggers([MODEL], "dwe6411 qs"), ["dwe6411"]);
  assert.deepEqual(triggers([MODEL], "DCD777S2T accu"), ["dcd777s2t"]);
  assert.deepEqual(triggers([MODEL], "dc motor"), []); // generic use of "dc" is not a model number
  assert.deepEqual(triggers([MODEL], "decoupeerzaag"), []);
});

test("market-specific entries only apply in their markets", () => {
  const e = [{ term: "hubo", mode: "word", markets: ["be"] }];
  assert.deepEqual(triggers(e, "hubo schuurmachine", "be"), ["hubo"]);
  assert.deepEqual(triggers(e, "hubo schuurmachine", "nl"), []);
});

test("terms with special characters are matched literally", () => {
  assert.deepEqual(triggers([{ term: "bol.com", mode: "word" }], "boormachine bol.com"), ["bol.com"]);
  assert.deepEqual(triggers([{ term: "bol.com", mode: "word" }], "bol com"), []);
  assert.deepEqual(triggers([{ term: "black+decker", mode: "substring" }], "black+decker boor"), ["black+decker"]);
});

// Shared input helpers: read a CSV/TSV export as it comes out of an ad platform.
// Written to be reusable across projects (no SQR-specific logic in this file).
//
// Handles the things real exports do:
//   - UTF-8 or UTF-16 encoding (with or without a byte-order mark)
//   - comma, tab or semicolon separators
//   - title / date-range lines above the real header row
//   - quoted fields containing separators, quotes or line breaks

/** Turn bytes (Uint8Array/Buffer) or a string into text, honouring a byte-order mark. */
export function decodeText(input) {
  if (typeof input === "string") return input.replace(/^\uFEFF/, "");
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  return new TextDecoder("utf-8").decode(b).replace(/^\uFEFF/, "");
}

/** Parse delimited text into an array of rows (arrays of strings). RFC 4180 quoting. */
export function parseDelimited(text, sep) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === "") inQuotes = true;
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Find the header row: the first row that contains every required column.
 * `columns` maps a field key to the header names it may appear under, e.g.
 * { searchTerm: ["search term"], ... }. Matching ignores case and extra spaces.
 * Returns { headerIndex, map: {key: columnIndex}, best } where `best` describes
 * the closest candidate when no row qualifies (used for a helpful error).
 */
export function findHeader(rows, required, optional = {}, maxScan = 30) {
  let best = { index: -1, found: [] };
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
    const cells = rows[i].map(norm);
    const map = {};
    for (const [key, names] of Object.entries({ ...required, ...optional })) {
      const idx = cells.findIndex((c) => names.includes(c));
      if (idx >= 0) map[key] = idx;
    }
    const found = Object.keys(required).filter((k) => k in map);
    if (found.length === Object.keys(required).length) return { headerIndex: i, map };
    if (found.length > best.found.length) best = { index: i, found };
  }
  return { headerIndex: -1, map: null, best };
}

/** Try each separator and keep the first one under which a full header row is found. */
export function readTable(input, required, optional = {}) {
  const text = decodeText(input);
  let fallback = null;
  for (const sep of ["\t", ",", ";"]) {
    const rows = parseDelimited(text, sep);
    const h = findHeader(rows, required, optional);
    if (h.headerIndex >= 0) return { rows, sep, ...h };
    if (!fallback || h.best.found.length > fallback.best.found.length) fallback = { rows, sep, ...h };
  }
  return fallback; // headerIndex === -1: caller reports which columns are missing
}

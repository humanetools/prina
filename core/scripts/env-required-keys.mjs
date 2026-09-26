#!/usr/bin/env node
// Required env key extractor (T8.4 patch purity gate #3)
//
// Usage: node env-required-keys.mjs <env.ts path>
// Output: required keys, sorted, one per line to stdout.
//
// Parses the source text instead of executing the zod schema — so it applies
// identically to env.ts from past tags without installing dependencies. Decision rule:
//   required = keys in the z.object literal that have neither .optional( nor .default(
// (if env.ts adopts other relaxing modifiers like .nullish(), update this rule too)

import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("Usage: env-required-keys.mjs <env.ts path>");
  process.exit(2);
}

const source = readFileSync(file, "utf8");

/** Extract the object literal body of z.object(, skipping comments and strings */
function extractObjectBody(src) {
  const start = src.indexOf("z.object(");
  if (start === -1) return null;
  let i = src.indexOf("{", start);
  if (i === -1) return null;
  const bodyStart = i + 1;
  let depth = 1;
  i = bodyStart;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) return null;
    } else if (ch === "/" && next === "*") {
      i = src.indexOf("*/", i + 2);
      if (i === -1) return null;
      i += 2;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < src.length && src[i] !== ch) {
        if (src[i] === "\\") i++;
        i++;
      }
      i++;
    } else {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
      if (depth === 0) return src.slice(bodyStart, i);
      i++;
    }
  }
  return null;
}

/** Split the object body into entries at top-level commas (safe for strings, nesting, comments) */
function splitTopLevelEntries(body) {
  const entries = [];
  let depth = 0;
  let current = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    const next = body[i + 1];
    if (ch === "/" && next === "/") {
      const nl = body.indexOf("\n", i);
      i = nl === -1 ? body.length : nl;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = body.indexOf("*/", i + 2);
      i = end === -1 ? body.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      current += ch;
      i++;
      while (i < body.length && body[i] !== ch) {
        current += body[i];
        if (body[i] === "\\") {
          current += body[i + 1];
          i++;
        }
        i++;
      }
      current += body[i];
      i++;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      entries.push(current);
      current = "";
    } else {
      current += ch;
    }
    i++;
  }
  if (current.trim()) entries.push(current);
  return entries;
}

const body = extractObjectBody(source);
if (body === null) {
  console.error(`z.object( literal not found: ${file}`);
  process.exit(2);
}

const required = [];
for (const entry of splitTopLevelEntries(body)) {
  const m = entry.match(/^\s*([A-Z][A-Z0-9_]*)\s*:/);
  if (!m) continue;
  if (!entry.includes(".optional(") && !entry.includes(".default(")) {
    required.push(m[1]);
  }
}

console.log(required.sort().join("\n"));

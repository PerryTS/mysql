// Post-tsc pass: rewrite relative imports in dist/*.{js,d.ts} to include
// explicit `.js` extensions.
//
// Why this exists: package.json declares `type: module`, but the
// TypeScript sources author imports as `from './connection'` (no
// extension) because tsconfig uses `moduleResolution: bundler`. Node's
// strict ESM loader (Node 22+) requires the file extension and won't
// resolve `./connection` against `./connection.js` on disk.
//
// Rather than touching all ~24 source files (and re-locking developers
// into adding `.js` to every TS import), patch only the compiled output.
// Source files stay clean; published `.js` is Node-strict-ESM compliant.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// Walk dist/ recursively, return absolute paths matching the predicate.
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

// Match: from|import|export ... from '...' / "..." where '...' is a
// relative path (./ or ../) with no extension. We deliberately do NOT
// touch absolute/package imports, nor imports that already end in a
// recognized extension (.js, .json, .css, .cjs, .mjs).
const RE = /((?:\bfrom\s+|\bimport\s*\(\s*|\bexport\s+\{[^}]*\}\s+from\s+|\bimport\s+(?:[\w*${},\s]+?\s+from\s+)?))(['"])(\.\.?\/[^'"\n]+?)\2/g;

function shouldSkip(path) {
  return (
    path.endsWith('.js') ||
    path.endsWith('.cjs') ||
    path.endsWith('.mjs') ||
    path.endsWith('.json') ||
    path.endsWith('.css')
  );
}

function rewrite(source) {
  let changed = 0;
  const out = source.replace(RE, (match, prefix, quote, path) => {
    if (shouldSkip(path)) return match;
    changed++;
    return `${prefix}${quote}${path}.js${quote}`;
  });
  return { out, changed };
}

let totalFiles = 0;
let totalChanged = 0;
for (const file of await walk(DIST)) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  const src = await readFile(file, 'utf8');
  const { out, changed } = rewrite(src);
  if (changed > 0) {
    await writeFile(file, out);
    totalFiles++;
    totalChanged += changed;
  }
}
console.log(`fix-esm-imports: rewrote ${totalChanged} import(s) across ${totalFiles} file(s)`);

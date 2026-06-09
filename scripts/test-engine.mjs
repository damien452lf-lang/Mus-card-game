// scripts/test-engine.mjs
// Lance les 121 tests du moteur de règles SANS navigateur.
// Usage : npm run test:engine   (ou : node scripts/test-engine.mjs)
//
// Principe : src/MusGame.jsx contient le moteur (sections 1-9, JS pur) puis
// l'UI React (à partir du marqueur "UI v2"). On extrait la partie moteur,
// on retire les imports React, et on exécute runTests().

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcPath = join(__dirname, '..', 'src', 'MusGame.jsx');
const src = readFileSync(srcPath, 'utf8');

const uiStart = src.indexOf('UI v2 — Refonte');
if (uiStart === -1) {
  console.error('ERREUR : marqueur "UI v2 — Refonte" introuvable dans src/MusGame.jsx');
  process.exit(2);
}
const cutoff = src.lastIndexOf('/*', uiStart);
const engineCode = src.slice(0, cutoff);

const cleaned = engineCode
  .replace(/^import [^;]+;\s*/gm, '')
  .replace(/^const \{[^}]+\}\s*=\s*React;.*$/gm, '')
  .replace(/^export\s+/gm, '');

const getTests = new Function(`${cleaned}\n; return runTests;`);
const runTests = getTests();
const results = runTests();

let pass = 0, fail = 0;
for (const r of results) {
  if (r.pass) pass++;
  else { fail++; console.log('FAIL:', r.name, '→', r.error); }
}
console.log(`\n=== ${pass} passed, ${fail} failed of ${results.length} ===`);
process.exit(fail > 0 ? 1 : 0);

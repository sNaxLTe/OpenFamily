// Runtime smoke test of the COMPILED shared dist — runs as part of
// `npm run build` (shared), so the Docker builder stage, local builds and CI
// all validate the emitted artifact, not just the TS sources.
//
// It catches exactly what crashed the server image at boot: the package is ESM
// ("type": "module") and used to emit extensionless relative imports
// (`export * from './constants'`), which Node's ESM loader cannot resolve
// (ERR_MODULE_NOT_FOUND '/app/shared/dist/constants').
//
// 1. import the built dist/index.js in this very Node process and check the
//    exports the app relies on are really there;
// 2. scan every emitted .js for a relative import/require/export-from WITHOUT
//    an explicit extension (.js/.mjs/.cjs/.json) — the ESM killer.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');

const failures = [];

// 1. The compiled entry point must import cleanly in Node.
const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../package.json'), 'utf8'));
if (pkg.type !== 'module') {
    failures.push('package.json must declare "type": "module" (the dist is ESM and is runtime-imported by the server)');
}
const entry = path.join(dist, 'index.js');
if (!fs.existsSync(entry)) {
    failures.push(`missing built entry ${entry} — run tsc first`);
} else {
    try {
        const mod = await import(pathToFileURL(entry).href);
        for (const name of ['LIST_ICONS', 'LIST_NAME_MAX', 'LIST_ITEM_TEXT_MAX', 'LIST_CATEGORY_MAX']) {
            if (mod[name] === undefined) failures.push(`dist export missing: ${name}`);
        }
        if (!Array.isArray(mod.LIST_ICONS) || mod.LIST_ICONS.length === 0) {
            failures.push('LIST_ICONS must be a non-empty array in the built dist');
        }
        console.log(`[check-dist] imported ${path.relative(process.cwd(), entry)} OK (${Object.keys(mod).length} exports, LIST_ICONS=${mod.LIST_ICONS?.length})`);
    } catch (error) {
        failures.push(`importing the built dist failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// 2. No extensionless relative specifier in the emitted JS.
const EXTENSIONLESS = /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const hasExtension = /\.(js|mjs|cjs|json|node)$/;
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);

if (fs.existsSync(dist)) {
    for (const file of walk(dist)) {
        // Strip comments first: tsc keeps the source comments, and a comment
        // quoting an extensionless import must not fail the check.
        const source = fs.readFileSync(file, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        for (const match of source.matchAll(EXTENSIONLESS)) {
            if (!hasExtension.test(match[1])) {
                failures.push(`${path.relative(dist, file)}: extensionless relative specifier '${match[1]}' (ESM cannot resolve it under Node)`);
            }
        }
    }
}

if (failures.length > 0) {
    console.error('[check-dist] FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log('[check-dist] OK: built dist imports cleanly and has no extensionless relative specifier');

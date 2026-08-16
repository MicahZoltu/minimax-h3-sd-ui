#!/usr/bin/env node
// Vendors the pinned Mediabunny package into app/vendor/mediabunny so the browser can import its ESM modules without a bundler or node_modules.
// The app is plain tsc ESM, so the runtime import must resolve to a real, served file.
// The vendored version must exactly match the pinned devDependency; fail loudly otherwise.
// This must run before "bun run build" (it is also the postinstall), because app/vendor is git-ignored and generated.

import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const pinned = pkg.devDependencies?.mediabunny;
if (typeof pinned !== "string" || pinned === "") {
	throw new Error("package.json must pin mediabunny as an exact version in devDependencies.");
}

const mbPkgPath = join(root, "node_modules", "mediabunny", "package.json");
const mbPkg = JSON.parse(await readFile(mbPkgPath, "utf8"));
if (mbPkg.version !== pinned) {
	throw new Error(`mediabunny version mismatch: package.json pins ${pinned}, but node_modules/mediabunny has ${mbPkg.version}. Run "bun install" first.`);
}

const src = join(root, "node_modules", "mediabunny", "dist", "modules");
const dest = join(root, "app", "vendor", "mediabunny");

// Flatten: only the emitted src and shared trees are vendored.
// src files import shared via "../shared/...", so shared must sit next to src.
await mkdir(dest, { recursive: true });
await cp(join(src, "src"), join(dest, "src"), { recursive: true });
await cp(join(src, "shared"), join(dest, "shared"), { recursive: true });

const srcModules = join(dest, "src");
// The worker imports these narrow modules directly (never the full index), so they must be present and fresh.
const required = ["conversion.js", "conversion.d.ts", "encode.js", "encode.d.ts", "input.js", "input.d.ts", "input-format.js", "input-format.d.ts", "output.js", "output.d.ts", "output-format.js", "output-format.d.ts", "source.js", "source.d.ts", "target.js", "target.d.ts"];
for (const file of required) {
	await stat(join(srcModules, file)).catch(() => {
		throw new Error(`vendored mediabunny is missing ${file} under src; run "bun install" then "bun run vendor" again.`);
	});
}

// The browser (no bundler here, just served ESM) must never fetch a "node:" specifier.
// Upstream dist/modules/src/node.js is `export * as fs from 'node:fs/promises'`, which the browser treats as a bare
// non-http module URL and blocks (the "CORS request not http" console error), so the worker that imports source.js and
// target.js fails to evaluate. Mediabunny only survives in bundlers, which honor its package.json "browser" field that
// maps src/node.js (and node:fs/promises) to false. This app ships un-bundled tsc ESM, so we substitute the two
// node-only files with a stub. source.js and target.js guard on `node.fs` being falsy and throw their "only available
// in server-side environments" error if a file-based source/target is ever constructed, which is correct browser
// behavior; the app never constructs those, only BlobSource and BufferTarget.
const nodeStubJs = `/* Derived from Mediabunny's src/node.js, replaced at vendor time by scripts/vendor-mediabunny.mjs.
 * Upstream does \`export * as fs from 'node:fs/promises'\`, which a browser cannot load; we serve un-bundled ESM with
 * no bundler to honor the package "browser" field, so fs is stubbed here. source.js and target.js hide node.js behind a
 * feature check (\`typeof nodeAlias !== 'undefined'\`) and gate FilePathSource/FilePathTarget on node.fs being set, so
 * making fs undefined keeps their "server-side only" throw correct in the browser. The app only uses BlobSource and
 * BufferTarget, never the file-based classes.
 */
export const fs = undefined;
`;
const nodeStubDts = `/* Derived from Mediabunny's src/node.d.ts, replaced at vendor time by scripts/vendor-mediabunny.mjs.
 * Mirrors nodeStubJs: the real fs namespace is server-only (node:fs/promises) and is intentionally omitted here.
 */
export declare const fs: undefined;
`;
await writeFile(join(srcModules, "node.js"), nodeStubJs, "utf8");
await writeFile(join(srcModules, "node.d.ts"), nodeStubDts, "utf8");

// Keep the served tree lean: drop source maps and tsc build info everywhere; .d.ts are required for tsc resolution.
const entries = await readdir(dest, { recursive: true });
for (const entry of entries) {
	if (!entry.endsWith(".map") && !entry.endsWith(".tsbuildinfo")) continue;
	const p = join(dest, entry);
	const s = await stat(p).catch(() => null);
	if (s && s.isFile()) await rm(p);
}

console.log(`vendored mediabunny@${mbPkg.version} -> ${dest}`);

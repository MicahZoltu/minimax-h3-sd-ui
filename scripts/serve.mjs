#!/usr/bin/env node
// Minimal dependency-free static server for the built ./app/ directory.
// Used by `pnpm dev`.
// Serves GET "/" as app/index.html and other GETs from files inside app/, guarded against path traversal.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appDir = resolve(root, "app");
const port = 52760;

const types = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".ts": "text/typescript; charset=utf-8",
	".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405);
		res.end();
		return;
	}
	const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
	const target = resolve(appDir, rel);
	if (target !== appDir && !target.startsWith(appDir + sep)) {
		res.writeHead(403);
		res.end("forbidden");
		return;
	}
	try {
		const buf = await readFile(target);
		const ext = "." + rel.split(".").pop();
		res.writeHead(200, {
			"content-type": types[ext] ?? "application/octet-stream",
			"cache-control": "no-store",
		});
		res.end(buf);
	} catch {
		res.writeHead(404);
		res.end("not found");
	}
});

server.listen(port, () => {
	console.log(`serve: http://localhost:${port}/ -> ${appDir}`);
});

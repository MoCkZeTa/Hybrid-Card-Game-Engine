/**
 * Copies the built-in game plugins into the build output.
 *
 * `tsc` compiles `.ts` and copies nothing else, but a game is a *folder* —
 * `rules.json` plus `strategy.md` — and `PluginManager.loadAll` scans that
 * folder relative to the running module. From `dist/server.js` that means
 * `dist/games/`, which tsc never created, so the compiled server failed at boot
 * with `ENOENT ... dist\games` and no game was playable.
 *
 * This went unnoticed because `npm run dev` uses `tsx src/server.ts`, where the
 * scan lands on `src/games/` and everything is already there. The production
 * path was the only one that was broken, and it is the one nobody ran.
 *
 * These files are shipped server content — source-controlled, immutable at
 * runtime — so belonging in the build output is correct. User-imported plugins
 * are a different thing entirely and live in `PluginRepository`, never on disk.
 */

import { cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(backendRoot, 'src', 'games');
const to = path.join(backendRoot, 'dist', 'games');

await cp(from, to, { recursive: true });

// Fail the build rather than ship a server that boots into an empty catalog.
const copied = await readdir(to);
if (copied.length === 0) throw new Error(`No game plugins were copied from ${from}`);
console.log(`Copied ${copied.length} built-in game plugin(s) to dist/games: ${copied.join(', ')}`);

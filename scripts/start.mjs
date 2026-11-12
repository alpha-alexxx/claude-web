#!/usr/bin/env node
/**
 * Server launcher: `node scripts/start.mjs [start|dev]` — wired to `npm start`
 * and `npm run dev`.
 *
 * Reads `.env` first, then starts Next on the host and port this app actually
 * declares — see `start-lib.mjs` for why the flags cannot come from Next's own
 * env handling.
 *
 * Loading order: real env wins over `.env` (Node's `loadEnvFile` does not
 * overwrite existing variables), so `HOST=0.0.0.0 npm start` still overrides
 * the file, exactly like every other setting.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nextBin, startArgs } from "./start-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    console.error(`[start] could not read .env: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

let args;
try {
  // No argument means the production server, so `node scripts/start.mjs` works
  // on its own; `npm run dev` passes `dev` explicitly.
  args = startArgs(process.env, process.argv[2] ?? "start");
} catch (error) {
  console.error(`[start] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const child = spawn(process.execPath, [nextBin(), ...args], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

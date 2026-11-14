import { createRequire } from "node:module";

/**
 * Pure helpers for `scripts/start.mjs`. Kept separate from the launcher so the
 * argument derivation can be unit-tested without spawning a server.
 *
 * Why a launcher exists at all: `next start` and `next dev` bind 0.0.0.0:3000
 * by default (only the PORT half has an env binding, and the docs say `PORT`
 * "cannot be set in `.env`"). This app's env schema declares HOST=localhost /
 * PORT=8765 and the plan is explicit that it must not listen on a public
 * interface unless the operator says so. Neither Next nor the schema can
 * enforce that on their own, so the launcher reads `.env` and passes the two
 * values as flags. The defaults here MATCH `lib/env.ts`; if they ever
 * diverge, the server would silently listen somewhere the UI does not say
 * it does.
 *
 * `localhost`, not `127.0.0.1`: Next normalizes every loopback request host to
 * the literal string `localhost` (`server/web/next-url.js`), while the router
 * compares a middleware rewrite against an origin built from this bind value.
 * The two must be spelled the same or an own-origin rewrite to another path is
 * classified external and the server proxies itself — `EPROTO wrong version
 * number` behind a TLS-terminating tunnel. Both names reach the same socket
 * (`/etc/hosts` maps localhost to 127.0.0.1), so nothing else changes.
 */
export const DEFAULT_HOST = "localhost";
export const DEFAULT_PORT = 8765;

/** Subcommands that bind a socket and therefore need the derived flags. */
export const SUBCOMMANDS = /** @type {const} */ (["start", "dev"]);

/**
 * Arguments for the Next child: `[subcommand, "-H", host, "-p", port]`.
 *
 * `dev` goes through the same derivation as `start` for the same reason: the
 * CLI reads `PORT` from the process env but has NO env binding for the
 * hostname (`-H` defaults to 0.0.0.0), and `.env` is loaded too late for
 * either. A development server that quietly listens on every interface is
 * the same exposure as a production one, only shorter-lived.
 *
 * Values are validated rather than passed through: `HOST` becomes an argv
 * element, and a value starting with `-` would be parsed as another flag.
 *
 * The subcommand's type is `string`, not the union it is checked against: the
 * value comes from argv, so the check in the body is the only thing that makes
 * it one of `SUBCOMMANDS`. Typing the parameter as the union would move that
 * check to the caller and the validation below could never be exercised.
 *
 * @param {{ HOST?: string, PORT?: string }} [env]
 * @param {string} [subcommand]
 * @returns {string[]}
 */
export function startArgs(env = {}, subcommand = "start") {
  const known = /** @type {readonly string[]} */ (SUBCOMMANDS);
  if (!known.includes(subcommand)) {
    throw new Error(
      `unknown subcommand ${JSON.stringify(subcommand)} (expected ${SUBCOMMANDS.join(" or ")})`,
    );
  }
  const rawHost = (env.HOST ?? "").trim();
  const host = rawHost === "" ? DEFAULT_HOST : rawHost;
  if (host.startsWith("-") || /\s/.test(host)) {
    throw new Error(`HOST must be a hostname or IP, got ${JSON.stringify(host)}`);
  }

  const rawPort = (env.PORT ?? "").trim();
  const port = rawPort === "" ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer in 1..65535, got ${JSON.stringify(rawPort)}`);
  }

  return [subcommand, "-H", host, "-p", String(port)];
}

/**
 * Absolute path to Next's CLI entry.
 *
 * `next` publishes no `exports` map, so its `bin` target is the only stable
 * reference to the script `npx next` runs. Resolved through `createRequire`
 * bound to this file because an ESM module has no `require` of its own — the
 * first version of the launcher called `require.resolve` directly and threw
 * `ReferenceError` on every real start while every test still passed (the
 * end-to-end case exits during argument validation, before this line).
 *
 * @param {string} [modulePath] the module to resolve `next` from
 * @returns {string}
 */
export function nextBin(modulePath = import.meta.url) {
  const require = createRequire(modulePath);
  return require.resolve("next/dist/bin/next");
}

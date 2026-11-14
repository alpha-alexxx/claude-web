import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HOST, DEFAULT_PORT, nextBin, startArgs } from "./start-lib.mjs";
/**
 * The launcher is the only thing standing between the env file and a server
 * listening on a public interface, so its argument derivation is pinned here.
 * The lib is plain ESM with no imports of the app — vitest imports it directly.
 */

const libPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "start-lib.mjs",
);

describe("startArgs", () => {
  it("binds the spelling Next normalizes request hosts to", () => {
    // The router builds its own origin for a request from the `-H` value
    // (`${hostname}:${port}`) and only treats a middleware rewrite as internal
    // when that origin matches the rewrite's. Next has already normalized the
    // rewrite's host to `localhost` (`next-url.js` rewrites 127.0.0.1/::1), so
    // binding `127.0.0.1` makes every own-origin rewrite to a DIFFERENT path
    // look external and the server proxies itself — a TLS handshake against a
    // plaintext port behind a tunnel. Both spellings reach the same socket, so
    // the bind has to use the one the comparison uses.
    expect(DEFAULT_HOST).toBe("localhost");
  });

  it("defaults to loopback on the app's declared port", () => {
    expect(startArgs({})).toEqual([
      "start",
      "-H",
      DEFAULT_HOST,
      "-p",
      String(DEFAULT_PORT),
    ]);
  });

  it("prefers declared HOST/PORT values", () => {
    expect(startArgs({ HOST: "0.0.0.0", PORT: "3000" })).toEqual([
      "start",
      "-H",
      "0.0.0.0",
      "-p",
      "3000",
    ]);
  });

  it("derives the same flags for the dev server", () => {
    // `npm run dev` goes through this launcher too. The dev CLI has no env
    // binding for the hostname either, so a launcher that special-cased
    // `start` would leave development listening on 0.0.0.0:3000.
    expect(startArgs({ PORT: "9400" }, "dev")).toEqual([
      "dev",
      "-H",
      DEFAULT_HOST,
      "-p",
      "9400",
    ]);
  });

  it("refuses an unknown subcommand rather than passing it to Next", () => {
    // The subcommand arrives from npm/argv, not from the env file, but it is
    // still an argv element: anything but the two this launcher derives would
    // be Next's own command line, so it is checked rather than forwarded.
    expect(() => startArgs({}, "build")).toThrow(/subcommand/);
    expect(() => startArgs({}, "--inspect")).toThrow(/subcommand/);
  });

  it("trims whitespace around the values", () => {
    expect(startArgs({ HOST: " localhost ", PORT: " 9000 " })).toEqual([
      "start",
      "-H",
      "localhost",
      "-p",
      "9000",
    ]);
  });

  it("refuses a HOST that could be read as a flag", () => {
    expect(() => startArgs({ HOST: "-p" })).toThrow(/HOST/);
    expect(() => startArgs({ HOST: "--inspect" })).toThrow(/HOST/);
  });

  it("refuses a HOST with whitespace — argv is the injection surface", () => {
    expect(() => startArgs({ HOST: "127.0.0.1 -p" })).toThrow(/HOST/);
  });

  it("refuses a non-integer or out-of-range PORT", () => {
    expect(() => startArgs({ PORT: "http" })).toThrow(/PORT/);
    expect(() => startArgs({ PORT: "0" })).toThrow(/PORT/);
    expect(() => startArgs({ PORT: "65536" })).toThrow(/PORT/);
  });

  it("is exercised end-to-end through the real launcher binary", () => {
    // The launcher must refuse a HOST that would be parsed as a flag rather
    // than passing it to `next start` — this is the run, not just the unit.
    const result = spawnSync(
      process.execPath,
      [path.join(path.dirname(libPath), "start.mjs")],
      {
        encoding: "utf8",
        env: { ...process.env, HOST: "-p" },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/HOST/);
  });

  it("resolves Next's CLI entry to a real file", () => {
    // The launcher is ESM and has no bare `require`; the first version called
    // `require.resolve` and threw on every real start while every other test
    // passed, because they all exit before the spawn. This is that line.
    const bin = nextBin();
    expect(bin).toMatch(/next[/\\]dist[/\\]bin[/\\]next$/);
    expect(existsSync(bin)).toBe(true);
  });

  it("spawns next start with the derived flags (no ReferenceError on the way in)", async () => {
    // Port 1 is reserved (tcpmux), so Next's CLI refuses it instantly and
    // writes a diagnostic — a deterministic way to prove the launcher reached
    // the spawn WITHOUT binding a socket or needing a build. The assertion is
    // on WHO wrote the message: `Bad port` is Next's own words; a
    // `ReferenceError` from the launcher's own frame is the regression this
    // test exists for.
    const child = spawn(
      process.execPath,
      [path.join(path.dirname(libPath), "start.mjs")],
      { env: { ...process.env, HOST: "127.0.0.1", PORT: "1" } },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`launcher did not exit; stderr: ${stderr}`));
      }, 120_000);
      child.once("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

    expect(code).not.toBe(0);
    expect(stderr).not.toMatch(/ReferenceError|require is not defined/);
    expect(stderr).toMatch(/Bad port|reserved/i);
  }, 150_000);
});

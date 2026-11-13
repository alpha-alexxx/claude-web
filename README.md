# claude-web

A self-hosted web app that puts a browser in front of coding-agent CLIs. Point it at a workspace, describe a task, and watch the agent work — text, thinking, tool calls, permission prompts — with no terminal required.

v1 ships adapters for all four CLIs — **Claude Code** (via `@anthropic-ai/claude-agent-sdk`), **Codex**, **OpenCode** and **Qoder** — behind one seam, plus the Integrations page, shared skills store, MCP generators and per-tool settings editors. Each CLI stays off until its id appears in `ENABLED_PROVIDERS`.

- **Chat** — streaming turns, thinking blocks, tool cards with diffs and terminal output, Stop, model picker, per-turn cost/token footer.
- **Permission prompts** — Claude's per-tool Allow / Allow for session / Deny cards, with every request and decision written to an audit table.
- **History** — conversations persisted in SQLite per user, resumable across server restarts via the CLI's own session id.
- **Skills** — one canonical store at `~/.agents/skills`, projected into each tool's expected location.
- **Plugins** — unified list with per-tool compatibility labels, install/uninstall through the owning CLI.
- **MCP servers** — one registry, generated into each tool's native config (JSON or TOML) without touching entries it does not own.
- **Settings** — per-tool config editors with secret redaction and timestamped backups.
- **Integrations** — detect, pinned-install and authenticate the other three CLIs.

## Requirements

- Node.js **≥ 22.13** (uses the built-in `node:sqlite`; before 22.13 it is
  behind `--experimental-sqlite`, and the app does not pass that flag — developed
  on 26.13). `package.json` pins the same floor in `engines`.
- A **Clerk** application (free tier is fine). You need its two API keys.
- A Claude Code login on this host (`claude`, or an existing `~/.claude` session). The app never handles Claude credentials — the SDK inherits the host login.

## Setup

```bash
yarn install          # or npm install
cp .env.example .env  # then fill in the two Clerk keys
yarn build
yarn start
```

Open `http://127.0.0.1:8765` and sign in. The **first account that signs in becomes the admin**; everyone after that is a regular user until an admin promotes them.

`npm run dev` runs the same launcher against `next dev`, so development also honours `HOST`/`PORT` from `.env`.

### Environment

Every variable is parsed and validated once at boot by `src/lib/env.ts` — a missing or malformed value fails fast with the variable named, rather than producing a half-configured server. `.env.example` is the complete list.

| Variable | Default | Notes |
|---|---|---|
| `CLERK_SECRET_KEY` | **required** | `sk_…`. Server-only. Never in client code. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | **required** | `pk_…`. Public by design, but must be a publishable key — the schema rejects an `sk_` here. |
| `DATABASE_PATH` | `./data/claude-web.db` | SQLite file. Its directory is created at boot, `0700` / file `0600`. |
| `HOST` | `127.0.0.1` | Where the server listens. See the note below. |
| `PORT` | `8765` | Same. |
| `TRUST_PROXY` | `false` | Honour `X-Forwarded-For` / `X-Forwarded-Proto` from the direct peer. Only enable behind a proxy you control. |
| `ALLOWED_WORKSPACE_ROOTS` | *(empty)* | Comma-separated absolute directories a conversation's cwd may resolve inside. Empty disables chat (no valid cwd). |
| `DEFAULT_MODEL` | `auto` | `auto` = the CLI's default. |
| `MAX_CONCURRENT_TURNS` | `2` | Concurrent agent sessions (each can use ~1 GiB). |
| `TURN_TIMEOUT_MS` | `1800000` | Hard stop for a single turn. |
| `CLAUDE_EXECUTABLE` | *(empty)* | Override for the Claude binary. Normally unused: the SDK bundles its own. |
| `ENABLED_PROVIDERS` | `claude` | Which adapters may activate. Unknown names fail at boot. |
| `INSTALL_ALLOWLIST` | *(empty)* | Exact-pinned npm specs the Integrations page may install. Empty = installs disabled. |

**`HOST` and `PORT` are read by the launcher, not by Next.** `next start` binds `0.0.0.0:3000` by default, only reads `PORT` from the process environment (the Next docs state `PORT` "cannot be set in `.env`"), and has no env binding for the hostname at all. `scripts/start.mjs` loads `.env` and passes both as `-H`/`-p` flags. Launching `next start` directly bypasses that and will listen on every interface.

## Using it

**Chat.** Pick a working directory (from `ALLOWED_WORKSPACE_ROOTS`) and send a message. The composer's Stop button interrupts the turn; closing the tab does not.

**Permissions.** When the agent asks to run a tool, a card appears in the transcript. *Allow* answers that one call, *Allow for session* adds it to an in-memory per-conversation allowlist, *Deny* refuses the call and lets the turn continue. Unanswered prompts deny after five minutes. Every request and decision is recorded in the `tool_calls` table — including denials, which are written before the decision is sent.

**Skills.** Author once in `~/.agents/skills/<name>/SKILL.md`. Claude reads it through the `~/.claude/skills` symlink; Codex and OpenCode read the store directly; Qoder gets per-skill links under `~/.qoder/skills`. Invoke with `/skill-name args` in any composer. A real directory where a symlink should be is reported as a conflict and never replaced.

**MCP servers.** Save servers in Settings → MCP servers, then sync them into each tool's config. Generation is ownership-based: only entries the app wrote are rewritten, so hand-added servers and unrelated keys survive byte-for-byte. A config that will not parse is refused rather than "repaired".

**Settings.** Each tool's config file is shown with secret-looking values replaced by `***`. Typing over a `***` replaces the secret; leaving it alone restores the stored value. A save that changes nothing writes nothing; a real change backs up the original first.

**Integrations.** Cards show whether each CLI is installed, its version, and how it authenticates. Installing is disabled unless the exact package spec appears in `INSTALL_ALLOWLIST`. Credentials for third-party CLIs go to `data/integrations.env` (0600) and are injected only into that provider's child process; the API reports `configured: true|false` and key names, never values.

## Providers

All four adapters ship. Which ones a deployment offers is `ENABLED_PROVIDERS` alone; a CLI that is not installed is reported by Integrations and refused at session start with a clear message rather than silently disappearing.

| | Claude Code | Codex | OpenCode | Qoder |
|---|---|---|---|---|
| Adapter in this build | **yes** | **yes** | **yes** | **yes** |
| Transport | Agent SDK (bundles its CLI) | `codex exec --experimental-json` | `opencode run --format json` (NDJSON) | `qoder --print --output-format stream-json` |
| Auth | host CLI login (inherited) | device code / API key | environment | personal access token |
| Per-tool permission prompts | **yes** | policy presets | policy rules | none (bypass mode) |
| Streaming text | **yes** | final message only | **yes** | **yes** |
| Skills | via `~/.claude/skills` symlink | native `~/.agents/skills` | reads `.agents` + `.claude` | managed links |
| MCP config | `~/.claude.json` | `~/.codex/config.toml` | `~/.config/opencode/opencode.json` | `~/.qoder/settings.json` |
| Install size | none (bundled) | ≈437 MiB | ≈204 MiB | ≈64 MiB |

Capability differences are declared by each adapter and drive the UI, not hard-coded per provider: where a CLI has no answerable per-call callback, the conversation header shows a policy selector instead of permission cards.

## Security model

Full detail in [SECURITY.md](SECURITY.md). The short version:

- **Identity is Clerk's.** The app stores no passwords. The local `users` table is an authorization mirror only — Clerk user id, email, display name, role, disabled flag.
- **Every route authenticates itself.** Proxy does the cheap page redirect; handlers call `requireActor()` because Next's docs warn that Proxy coverage can be silently lost by a matcher change.
- **State-changing requests must be same-origin** (Origin/Host match; a missing Origin means a non-browser client, which carries no ambient credentials).
- **Rate limits** are in-memory sliding windows keyed by user: 10 turns/min, 5 privileged integration actions/hour, 60 render mints/min and 180 render reads/min. There is no per-IP general-API bucket — read routes are bounded by authentication instead.
- **Working directories are contained**: the client's cwd is `realpath`-resolved and rejected unless it is inside a configured root, so a symlink cannot escape.
- **Agent output is never rendered as HTML.** There is no markdown renderer and no `dangerouslySetInnerHTML`; transcripts render as text.
- **Images go through a token proxy.** A client POSTs a path or URL, the server validates it (containment for local paths, https-only + SSRF policy for remote) and mints a 5-minute HMAC token bound to the user; the GET re-validates and streams bytes with `nosniff` and a `sandbox` policy. SVG is refused.
- **No shell, ever.** Every exec uses an argv array with an allowlisted binary and an exact version pin; no user-supplied string reaches a shell.
- **Secrets stay server-side.** Settings values are always redacted in API responses; third-party credentials are written to a 0600 file and never returned.

## Deploying behind a proxy

The app is meant to listen on loopback and be fronted by a TLS terminator.

```nginx
location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;          # SSE: stream turns as they arrive
    proxy_read_timeout 1h;
}
```

Then set `TRUST_PROXY=true` so rate-limit keys use the real client IP and HSTS is emitted only for requests that actually arrived over TLS. Behind a proxy, keep `HOST=127.0.0.1` — the proxy is the only thing that should reach the port.

Security headers come from three places by design: static ones (`nosniff`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`) in `next.config.ts` so they cover static assets too; the **CSP** from the Proxy, built by Clerk's own builder because it knows the sign-in script and challenge hosts; **HSTS** from the Proxy only when the request is secure. None of them is duplicated: the Proxy's headers are applied before the response is sent, and a header already present wins, so a `headers()` entry *or* a route-handler header for the CSP would be silently dropped. Route handlers therefore set only what is theirs (`/api/render` adds `nosniff` and `Content-Disposition`, never a CSP).

### Clerk dashboard settings

For a self-hosted single-operator instance, in the Clerk Dashboard:

- **Disable sign-ups** once your accounts exist (the first account created becomes admin).
- Add your hostname to the allowed origins.
- Leave MFA/session lifetime at the defaults unless you have a reason; Clerk owns sessions.

## Troubleshooting

**Server listens on `0.0.0.0:3000` instead of `127.0.0.1:8765`.**
You ran `next start`/`next dev` directly. Use `yarn start` / `yarn dev` — they go through `scripts/start.mjs`, which is the only thing that applies `HOST`/`PORT`.

**`invalid environment configuration — CLERK_SECRET_KEY: …` at boot.**
The message names the variable. A common cause is putting the publishable key in `CLERK_SECRET_KEY` (or an `sk_` key in a `NEXT_PUBLIC_` variable; the schema refuses both).

**Chat says no provider is available.**
`ENABLED_PROVIDERS` is empty, or names only CLIs this build has no adapter for. It defaults to `claude`; add the others once their CLI is installed, e.g. `ENABLED_PROVIDERS=claude,codex,opencode,qoder`. A provider enabled in the Integrations page but absent here stays listed as inactive — the page records intent, `ENABLED_PROVIDERS` decides what chat may offer.

**Sending a message returns 400 `cwd outside allowed workspace roots`.**
`ALLOWED_WORKSPACE_ROOTS` is empty, or the chosen directory is outside it, or it no longer exists. Roots are resolved with `realpath`, so a root that is itself a symlink resolves to its target.

**First sign-in is a regular user, not admin.**
The first user *ever* in the database is admin. If the database was reset but Clerk already has accounts, the first account to sign in after the reset takes the admin role.

**`yarn build` takes a very long time.**
Production builds of this app are genuinely slow on a small machine — expect tens of minutes cold (compile and type-check are each in the tens of minutes here), and treat warm builds as roughly half. Turbopack's "Dynamic filesystem access causes tracing of the whole project" warnings are expected: several features resolve paths against the home directory or `PATH`.

**Images in tool output do not appear.**
No markdown renderer ships in v1 — transcripts render as text, so an image reference is text. The render endpoint and its token protocol are in place for a future preview surface.

**An agent can read `~/.claude`, `~/.codex`, `~/.ssh`.**
True by design and stated in SECURITY.md: agents run as the same OS user as the server, exactly as the CLIs do. Permission prompts and the sandbox reduce it; run the app as a dedicated user if that matters to you.

## Development

```bash
yarn dev            # launcher + next dev
yarn test           # vitest (740+ tests)
yarn lint           # eslint
npx tsc --noEmit    # typecheck
yarn build          # production build
```

Tests are colocated (`*.test.ts`) and cover the security-critical units: authorization, workspace containment, rate windows, env parsing, the SSE pipe and message mapper, integrations, skills/MCP/settings stores, plugins, and the render token protocol.

## Layout

```
src/
  app/                 routes; each api route authenticates itself
    api/               bootstrap, chat, conversations, health, integrations,
                       mcp, permissions, plugins, render, settings, skills
  components/          chat, tools, layout, settings, skills, plugins, ui
  lib/
    auth/              current-actor, authorize, request-guards, rate-limit
    chat/              bootstrap, transcript, recorder, conversation views
    db/                node:sqlite client, migrations, repos, boot singleton
    integrations/      registry, detect, installer, credentials, disk
    providers/         the adapter seam: types, registry, claude/ codex/ opencode/ qoder/
    render/            HMAC tokens, mime sniffing, SSRF-checked fetches
    skills/ mcp/ settings/ plugins/   shared stores + per-tool projection
scripts/start.mjs      the only process that binds HOST:PORT
data/                  SQLite + credentials (gitignored, 0700)
```

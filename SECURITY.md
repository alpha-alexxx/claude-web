# Security model

This app runs coding agents with the same OS privileges as the server process, on a host you control. It is built for **one operator plus accounts the operator chooses to create** — not for public signup, and not for untrusted tenants.

That single assumption explains most of the decisions below. Where a protection is impossible under it, this document says so rather than implying it.

## Identity and authorization

**Clerk is the identity provider.** Sign-in, sign-up, MFA, session cookies, session revocation and password storage are all Clerk's. The app stores no credentials of any kind.

The `users` table in SQLite is an **authorization mirror**, not an account table:

| column | purpose |
|---|---|
| `id` | the Clerk user id (`user_…`), primary key — no second mapping table |
| `email`, `display_name` | refreshed from Clerk on every authenticated request |
| `role` | `admin` or `user` |
| `disabled` | operator switch; a disabled user is refused at every gate |

Rows are created on first authenticated request (`ensureUser`). The **first row ever written becomes admin**; everyone after is a regular user. There is no webhook and no password path to bypass.

Every route handler authenticates itself with `requireActor("user" | "admin")`, which resolves Clerk's session, refreshes the local row, and applies `authorize()`:

- no session → `401 unauthenticated`
- a Clerk user with no usable email address cannot be mirrored locally, so it is also `401 unauthenticated` (the resolver returns no actor; there is no separate `no_email` code on the wire)
- `disabled` → `403 account_disabled`
- admin-only route and role is `user` → `403 forbidden`

The Proxy (`src/proxy.ts`) does the cheap page-level redirect to `/sign-in` for protected page roots only. It is deliberately *not* the security boundary: Next's own docs warn that Proxy coverage can be silently lost when routes move or matchers change, so protection lives in the handlers and the pages.

Authorization is split:

- **Regular users**: chat, conversations, bootstrap, health, permissions, render.
- **Admins only**: integrations (list/detail/install/auth), MCP registry and sync, plugins (list/install/uninstall), all per-tool settings editors, skills listing and sync. These act on host-wide operator state — the CLI configs in the server's home directory — so they are not delegated.

## Request hardening

**Same-origin check.** Every state-changing API request passes `sameOrigin()`: a present `Origin` must match the request `Host`; a missing `Origin` is allowed (non-browser clients carry no ambient credentials) but the route's own authentication still applies. There is no double-submit CSRF token because Clerk's session cookie is `SameSite`-scoped and the app makes no cross-origin requests.

**Rate limits.** In-memory sliding windows, single process, reset on restart, applied per route:

| bucket | limit | applied to | key |
|---|---|---|---|
| chat turns | 10 / min | `POST /api/chat`, `/api/chat/[id]/model`, `/api/permissions/[requestId]` | user |
| privileged integration actions | 5 / hour | CLI install/uninstall, credential write, plugin install/uninstall | user |
| integrations reads | 30 / min | `GET /api/integrations` (each `?refresh=1` spawns version probes) | user |
| render token mint | 60 / min | `POST /api/render` | user |
| render token redeem | 180 / min | `GET /api/render?token=…` — a token is reusable for 5 min and a remote one re-fetches on every read, so minting alone would not bound reads | user |
| admin writes | 30 / min each | MCP registry, per-tool settings PUT, skill sync (three separate buckets) | user |
| MCP sync | 20 / min | `POST /api/mcp/sync` | user |

There is no separate per-IP general-API bucket; read endpoints are bounded by authentication and by the fact that each spawns at most one cached CLI probe. Windows are swept on a cadence (every 256 calls) so a client that cycles source addresses cannot grow the limiter's map without bound. `429` responses carry `Retry-After`. The client IP is the socket peer unless `TRUST_PROXY=true`, in which case the **last** `X-Forwarded-For` entry is used — the one the proxy appended, not the first, which the client controls. Enabling `TRUST_PROXY` without a proxy in front lets any client forge its own limit key.

**Body limits and validation.** Every route validates its body with zod, so an accepted body is bounded by its schema regardless. On top of that, a declared `Content-Length` is checked before the body is buffered: general bodies (chat, MCP registry, per-tool settings) are capped at 1 MB, the rest of the default mutation cap at 64 KB, render requests at 16 KB, and permission answers at 4 KB. Ids, paths, tool names and package specs are pattern-checked before use.

**Security headers.** Three owners, no overlap:

| header | owner | why there |
|---|---|---|
| `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy` | `next.config.ts` `headers()` | unconditional and additive; also covers static assets |
| `Content-Security-Policy` | Proxy, via Clerk's builder + our overrides | Clerk knows its script/frame/challenge hosts; a static entry would be assigned *after* the Proxy and silently replace it |
| `Strict-Transport-Security` | Proxy, only when the request is actually secure | static config cannot know whether the request arrived over TLS |

HSTS is emitted only for an HTTPS request; behind a proxy, `X-Forwarded-Proto` is honoured only when `TRUST_PROXY` is set. A forged value cannot downgrade a site for a year.

**CSP form.** Nonce-based CSP is incompatible with partial prerendering, and this app runs `partialPrefetching`, so the policy keeps Clerk's non-strict form. The real `script-src` is broader than "self plus a nonce" and that is worth stating: `'self' 'unsafe-inline' https: http:` plus Stripe's and Google Maps' hosts and `*.protect.clerk.com` (Clerk's bot-protection script), with `'unsafe-eval'` added in development. `https:`/`http:` mean any origin can serve a script, so `script-src` is not a meaningful defense and is not treated as one. The compensating control is structural — **no agent output is ever rendered as HTML**. There is no markdown renderer, no `dangerouslySetInnerHTML`, and transcripts render as `pre-wrap` text. Overrides added on top of Clerk's defaults remove what nothing here can use: `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, `form-action 'self'`, and `img-src` gains `data:`/`blob:` for previews.

## Agent execution

**Working directory containment.** A conversation's cwd arrives from the client. It must be absolute, must exist, and its `realpath` must resolve inside one of `ALLOWED_WORKSPACE_ROOTS`. Nonexistent paths and roots are rejected rather than created, so both a missing root and a symlink escape fail closed. This is the chokepoint that stops "chat with `/etc`".

**Permissions.** Claude's SDK exposes a per-tool callback; each request becomes a card in the transcript with Allow / Allow for session / Deny.

- *Allow for session* adds the tool to an **in-memory, per-conversation** allowlist. It is dropped when the session closes, evicted or the server restarts.
- Unanswered prompts deny on timeout.
- **Every request is written to `tool_calls` before the decision is sent**, so a denial is auditable — the audit row is not contingent on approval.
- Evicting or closing a session denies every pending prompt immediately.

The other CLIs expose no answerable per-call callback, so their adapters carry a **fixed** policy instead and no permission cards appear for them: Codex runs `--sandbox workspace-write` with `approval_policy="never"`, OpenCode runs `--auto`, Qoder runs `--permission-mode bypass_permissions`. A policy that *waits* is deliberately not offered — `codex exec` and `opencode run` have no way to ask, so it would hang the turn until the SSE timeout on a card nobody could click. The sandbox, not an approval, is the boundary. These are ruled defaults in each adapter, not user-configurable in this build. Their tool calls stream into the transcript, but only Claude's reach the `tool_calls` audit table — see limitation 4.

**What an agent can reach.** Agents run as the same OS user as the server. They can read the operator's home directory — `~/.claude`, `~/.codex`, `~/.qoder`, `~/.ssh`, OpenCode's SQLite credential store — **exactly as those CLIs can when run from a terminal**. Permission prompts and each tool's sandbox reduce this; they do not eliminate it. This is a stated limitation, not a bug: run the server as a dedicated OS user, with a home directory that holds only what agents should see, if that boundary matters.

**No shell.** Every process spawn uses an argv array — CLI installs, plugin install/uninstall, MCP/config writes, version probes. Binaries and package specs come from the app's own registry, never from a request body, and installable specs must additionally appear verbatim in `INSTALL_ALLOWLIST` (empty = installs disabled). No user-supplied string reaches `sh -c`.

## Secrets

**Claude credentials are never handled.** The app does not set `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, and does not accept an API key for Claude. The SDK spawns the host's CLI with its inherited login, so the host's own credential precedence wins. Storing a key here would silently outrank a subscription login. `apiKeySource` from the CLI's init frame is surfaced as provider health instead.

**Third-party CLI credentials** (Codex, OpenCode, Qoder) are entered on the Integrations page and written to `data/integrations.env`:

- mode `0600`, parent directory `0700`, both set explicitly after creation (a directory mode passed to `mkdir` is umask-subject and ignored for an existing directory);
- never in SQLite, never in `process.env`, never in a log line;
- injected only into that provider's child process;
- every API surface exposes `configured: true | false` and **key names only** — never a value, not even a masked tail;
- keys are validated against the provider's declared list, so the endpoint cannot be used as a general-purpose secret writer;
- the audit row records *which keys* were set, never the values.

**Per-tool settings files** (`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.config/opencode/opencode.json`, `~/.qoder/settings.json`) are served redacted: any secret-named value at any depth is replaced with `***`. A PUT carrying `***` restores the stored value rather than writing the marker, and a typed value replaces it. A file that does not parse is refused for both read and write — the parse is what performs the redaction, so echoing raw bytes would hand a secret to the browser.

**Environment.** `src/lib/env.ts` is the only place `process.env` is parsed, and it imports `server-only`, so any client component that imports it fails the build rather than shipping a secret. Two variables are required (`CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`); the schema refuses an `sk_` key in a `NEXT_PUBLIC_` variable. `.env` is gitignored; `.env.example` carries no values.

## Render endpoint

Agent-supplied images never reach the DOM as a raw path or URL. The client POSTs a target; the server validates it and answers with a token; the GET redeems it.

- **Local path**: must resolve (realpath) inside `ALLOWED_WORKSPACE_ROOTS`; ≤ 10 MB.
- **Remote URL**: `https:` only; no private, loopback, link-local or IPv4-mapped destinations; no redirects (a `302` to loopback is the classic bounce); 5 s timeout; ≤ 10 MB enforced on both the declared length and the streamed body.
- **Tokens**: HMAC over a 32-byte key generated once into `data/render.key` (0600), bound to the **user id** (not a rotating Clerk session id) and valid for 5 minutes. The containment decision is re-validated at redemption — a token caches the decision, it never bypasses it.
- **Response**: the type is decided by **magic bytes**, not by extension or a remote server's `Content-Type`; only png/jpeg/gif/webp/avif/ico are served. **SVG is refused**: inline SVG is an HTML document, and a same-origin URL that executes script is exactly what this endpoint exists to prevent. Every response is `no-store`, `nosniff` and `Content-Disposition: inline` under that sniffed type. It sets no CSP of its own — the Proxy owns that header for every response, and a route-level copy would be dropped (see the header table above). Containment here is the type set plus `nosniff`, not a per-response policy.

## Data at rest

- `data/` is gitignored, created at boot at mode `0700`; the SQLite file is `0600`. The modes are set with `chmod` after creation because umask widens them, and a filesystem that refuses the change logs a warning naming the directory rather than claiming the promise was kept.
- `data/` holds conversation transcripts, the audit log, `integrations.env` and `render.key`.
- SQLite runs in WAL mode with foreign keys on; `busy_timeout` is 5 s. Conversations are owner-scoped in SQL (`WHERE user_id = ?`), never filtered in JavaScript afterwards.
- There is no backup automation. Copy `data/` while the server is stopped if you want one — and treat the copy as credential material.

## Audit log

Privileged actions write to `audit_log`: installs (a `start` row *before* the work and an outcome row after, so a timed-out half-install is attributable), uninstalls, credential writes, plugin installs/removals, MCP syncs, skill syncs, settings writes and every tool permission decision. Detail JSON never contains a secret value.

## Known limitations, stated plainly

1. **Agents share the server's OS identity** and can read everything it can — see above. Filesystem isolation between the app and its agents does not exist in this build.
2. **Rate limits are per process and in memory.** A restart clears them; running more than one server process multiplies them.
3. **`script-src` keeps `'unsafe-inline'` and `https:`/`http:`.** Partial prerendering rules out a nonce policy, and Clerk's builder treats `script-src` as a host-union list rather than a narrow allowlist, so in practice `script-src` is not a boundary at all. The protection rests on never rendering agent text as HTML, which is a code-level invariant (see the CSP paragraph above).
4. **The `tool_calls` audit table is Claude-only.** Codex, OpenCode and Qoder have no approval round trip, so there is no request or decision to record; their tool calls appear in the transcript and in `messages`, not in `tool_calls`. Reading that table as a complete record of what an agent did under-reports every provider except Claude. Their permission boundary is the fixed policy described under *Agent execution*.
5. **No admin user-management UI.** Roles are set on the first user automatically; promoting or disabling someone means editing the local row (or the Clerk dashboard for identity). `setUserRole`/`setUserDisabled`/`countEnabledAdmins` exist in `users-repo` but no API exposes them.
6. **Sign-up closure is a Clerk setting.** This app will accept any user Clerk authenticates. Disable sign-ups in the Clerk dashboard for a closed instance.

## Reporting

This is a self-hosted application with no vendor endpoint. Report issues to whoever runs your instance.

# claude-web

A single-process web UI that wraps the local Claude Code CLI and resembles
claude.ai. Zero native dependencies, no frontend build step, small memory
footprint (~20 MB Python process + ~90 KB of vendored JS).

```
python3 server.py                # http://127.0.0.1:8765 (loopback, no auth)
python3 server.py --port 9000 --cwd /some/project

# public bind — credentials REQUIRED (server refuses to start without them):
export CLAUDE_WEB_USER=claude
export CLAUDE_WEB_PASSWORD='...'        # or: export CLAUDE_WEB_PASSWORD_FILE=~/.secret
python3 server.py --host 0.0.0.0 --port 6200
```

## Authentication

- Without credentials the server binds loopback only — that is the default and
  the safe mode.
- Setting `CLAUDE_WEB_USER` + `CLAUDE_WEB_PASSWORD` (or `CLAUDE_WEB_PASSWORD_FILE`
  pointing at a file containing the password) enables HTTP **Basic auth**:
  every request — static pages and `/api/*` alike — must carry valid credentials.
  Wrong or missing credentials get `401` with a small delay to blunt brute force.
- Passwords are compared with `hmac.compare_digest` and never appear in argv
  (visible in `ps`) or on disk outside the optional password file.
- Basic auth sends credentials base64-encoded on **every** request. Over plain
  HTTP anyone on the network path can read them. For anything beyond a private
  VM, put the server behind a TLS reverse proxy (caddy/nginx) or tunnel over
  SSH.


## What it does

- **Chat** with the Claude Code CLI from the browser. Text streams in token
  by token; tool calls and thinking appear as collapsible cards.
- **Sessions** work like claude.ai: the sidebar lists every previous CLI
  session for the working directory (read directly from the CLI's own
  transcripts in `~/.claude/projects/` — zero extra CLI invocations), click
  one to load its full transcript, "New chat" starts fresh. Each turn resumes
  the CLI session via `--resume`, so history carries over both in the UI and
  in the real CLI.
- **Stop button** kills the running `claude` process group (SIGTERM → SIGKILL).
  The transcript stays valid and resumable.
- **Model picker** (`auto` / `sonnet` / `opus` / `haiku`) and a per-turn
  cost/token/duration footer.

## Permission model (read the full-access part)

- **Default: read-only.** Sessions run with `--allowedTools
  Read,Glob,Grep,WebFetch,WebSearch,TodoWrite,Task`, an explicit deny list for
  `Bash,Edit,Write,NotebookEdit`, and `--permission-prompts none` so anything
  not allow-listed is auto-denied instead of hanging.
- **Full access toggle** (header pill, with a confirm dialog) runs
  `--dangerously-skip-permissions`. In that mode the model can run arbitrary
  commands and edit files **as your user**. It can read `~/.claude/settings.json`
  (which may contain API credentials in plaintext) — no wrapper can prevent
  that. Only enable it for prompts you trust, and prefer running the server
  with `--cwd` pointed at a scratch directory when experimenting.

## Security posture

- Binds `127.0.0.1` only by default; a wider `--host` bind **refuses to start**
  unless `CLAUDE_WEB_USER`/`CLAUDE_WEB_PASSWORD` are set (Basic auth gates
  every route), or `--insecure-no-auth` is passed explicitly.
- `Host` header check blocks DNS rebinding on loopback; when bound publicly,
  `Origin` must exactly match the request's own `Host` (same-origin only), and
  POSTs additionally require the `X-Requested-With: claude-web` header —
  cross-site pages can't add it without a CORS preflight, and none is ever
  answered.
- Strict CSP (`default-src 'self'`, no inline scripts), session ids are
  regex-validated before touching the filesystem, request bodies capped at
  1 MB.
- Windows is not supported (POSIX process groups are used for clean kills).

## Layout

```
server.py               the whole backend (stdlib only)
static/index.html       UI shell (CSP: no inline scripts)
static/app.js           frontend logic, SSE client, markdown
static/style.css        claude.ai-like theme, light + dark
static/vendor/          marked 18.1.3 + DOMPurify 3.4.17 (pinned)
fetch-vendor.sh         re-download the vendored libs (setup, not build)
```

## Verification

```sh
python3 -m py_compile server.py
python3 server.py &                     # then:
curl -s http://127.0.0.1:8765/api/health
curl -s http://127.0.0.1:8765/api/sessions | python3 -m json.tool | head
# live streamed turn (note the required headers):
curl -sN -X POST http://127.0.0.1:8765/api/chat \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:8765' \
  -H 'X-Requested-With: claude-web' \
  -d '{"message":"Say ok"}'
# cross-site request must be rejected (expect 403):
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8765/api/chat \
  -H 'Origin: http://evil.example' -d '{}'
```

If the vendored libraries are missing (offline machine), the UI falls back to
a built-in escape-first markdown renderer automatically.

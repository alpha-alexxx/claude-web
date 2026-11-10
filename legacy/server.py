#!/usr/bin/env python3
"""claude-web — a single-process web UI wrapping the local Claude Code CLI.

Zero native dependencies, no frontend build step, small memory footprint.
Serves a static Claude-like chat UI and drives `claude -p --output-format
stream-json` one headless turn at a time, relaying events to the browser
over server-sent events. Session history is read directly from the CLI's
own JSONL transcripts (~/.claude/projects/<munged-cwd>/<uuid>.jsonl), so
the sidebar and transcript replay cost zero CLI invocations.

Usage:
    python3 server.py [--port 8765] [--host 127.0.0.1] [--cwd DIR]

Security model: binds 127.0.0.1 by default; optional HTTP Basic auth for
non-loopback binds (credentials come from the environment, never argv);
Host and same-origin/X-Requested-With checks block cross-site requests;
sessions run with a read-only tool allowlist unless the user explicitly
enables full access in the UI.
"""

import argparse
import base64
import collections
import glob
import hmac
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# Read-only tool policy: everything not allow-listed is auto-denied because
# we also pass --permission-prompts none (never hang waiting for approval).
READONLY_ALLOWED = "Read,Glob,Grep,WebFetch,WebSearch,TodoWrite,Task"
READONLY_DISALLOWED = "Bash,Edit,Write,NotebookEdit"

MODEL_OPTIONS = ["auto", "sonnet", "opus", "haiku"]

MAX_BODY_BYTES = 1 * 1024 * 1024          # request body cap
MAX_TOOL_OUTPUT_CHARS = 2000              # tool result preview sent to browser
MAX_TOOL_INPUT_CHARS = 4000               # tool input JSON kept in replay
MAX_REPLAY_BLOCKS = 400                   # transcript blocks returned per load
TURN_WATCHDOG_SECS = 30 * 60              # hard kill for runaway turns
MAX_CONCURRENT_TURNS = 2                  # each claude proc is ~150-300MB
SSE_PING_SECS = 15

SESSION_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)

APP_STATE = {
    "cli_bin": None,
    "cli_version": None,
    "cwd": os.getcwd(),
    "host": "127.0.0.1",
    "port": 8765,
    "public": False,
}

# HTTP Basic auth. Credentials live only in the environment or a chmod-600
# file — never in argv (which `ps` exposes) and never hardcoded here.
AUTH = {"user": None, "password": None}


def load_auth_config():
    """Enable Basic auth when CLAUDE_WEB_USER + CLAUDE_WEB_PASSWORD are set.

    CLAUDE_WEB_PASSWORD_FILE=/path/to/file reads the password from a file
    instead, so the secret stays out of shell history and process env.
    Returns True when auth is active.
    """
    user = os.environ.get("CLAUDE_WEB_USER", "").strip()
    pw_file = os.environ.get("CLAUDE_WEB_PASSWORD_FILE", "").strip()
    if pw_file:
        try:
            with open(os.path.expanduser(pw_file), "r", encoding="utf-8") as fh:
                password = fh.read().strip()
        except OSError:
            password = ""
    else:
        password = os.environ.get("CLAUDE_WEB_PASSWORD", "")
    if user and password:
        AUTH["user"] = user
        AUTH["password"] = password
    return bool(AUTH["user"])

# turn bookkeeping: keyed by requested session id (if any) and by the CLI's
# own session id once the init event reveals it.
TURNS = {}
TURNS_LOCK = threading.Lock()
TURN_SEMAPHORE = threading.BoundedSemaphore(MAX_CONCURRENT_TURNS)

# ---------------------------------------------------------------------------
# CLI locator
# ---------------------------------------------------------------------------

def find_claude_bin():
    """Resolve the claude CLI binary. Returns a path or None."""
    override = os.environ.get("CLAUDE_WEB_CLAUDE_BIN")
    candidates = []
    if override:
        candidates.append(override)
    which = shutil.which("claude")
    if which:
        candidates.append(which)
    candidates.append(os.path.expanduser("~/.local/bin/claude"))
    # nvm installs: ~/.nvm/versions/node/*/bin/claude (prefer newest node)
    nvm_hits = sorted(
        glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/claude"))
    )
    candidates.extend(reversed(nvm_hits))
    candidates.extend(["/usr/local/bin/claude", "/usr/bin/claude"])
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return os.path.abspath(c)
    return None


def detect_cli_version(cli_bin):
    try:
        out = subprocess.run(
            [cli_bin, "--version"], capture_output=True, text=True, timeout=15
        )
        v = (out.stdout or "").strip().splitlines()
        return v[0] if v else None
    except Exception:
        return None

# ---------------------------------------------------------------------------
# Session store — reads the CLI's own JSONL transcripts
# ---------------------------------------------------------------------------

def projects_root():
    return os.path.expanduser("~/.claude/projects")


def munged_cwd(cwd):
    """Mirror the CLI's session-dir naming: /home/ubuntu -> -home-ubuntu."""
    return os.path.abspath(cwd).replace("/", "-")


def session_dir_for(cwd):
    return os.path.join(projects_root(), munged_cwd(cwd))


def session_path_for(cwd, session_id):
    if not SESSION_ID_RE.match(session_id or ""):
        return None
    return os.path.join(session_dir_for(cwd), session_id + ".jsonl")


_WRAPPER_RES = [
    re.compile(r"<local-command-caveat>.*?</local-command-caveat>", re.S),
    re.compile(r"<system-reminder>.*?</system-reminder>", re.S),
    re.compile(r"<command-name>.*?</command-name>", re.S),
    re.compile(r"<command-message>.*?</command-message>", re.S),
    re.compile(r"<command-args>.*?</command-args>", re.S),
    re.compile(r"<local-command-stdout>.*?</local-command-stdout>", re.S),
]


def strip_wrappers(text):
    """Remove CLI wrapper noise so real user text survives for titles."""
    for rx in _WRAPPER_RES:
        text = rx.sub("", text)
    return text.strip()


def _text_from_content(content):
    """message.content may be a plain string or a list of blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("text") or "")
        return "\n".join(parts)
    return ""


def _tool_summary(name, input_obj):
    """One-line human digest of a tool call, for the quiet tool row."""
    try:
        if not isinstance(input_obj, dict):
            return ""
        if name in ("Bash",):
            return (input_obj.get("command") or "").splitlines()[0][:120]
        if name in ("Read", "Write", "Edit", "NotebookEdit"):
            return input_obj.get("file_path") or input_obj.get("notebook_path") or ""
        if name in ("Glob",):
            return input_obj.get("pattern") or ""
        if name in ("Grep",):
            return input_obj.get("pattern") or ""
        if name in ("WebFetch",):
            return input_obj.get("url") or ""
        if name in ("WebSearch",):
            return input_obj.get("query") or ""
        if name in ("Agent", "Task"):
            return input_obj.get("description") or ""
        if name == "AskUserQuestion":
            qs = input_obj.get("questions") or []
            if qs and isinstance(qs[0], dict):
                return qs[0].get("question", "")[:120]
            return ""
        if name == "TodoWrite":
            return "todo list update"
        s = json.dumps(input_obj, ensure_ascii=False)
        return s[:120]
    except Exception:
        return ""


def iter_session_blocks(path):
    """Yield normalized transcript blocks from a session JSONL file.

    Same block shape the live event stream produces, so the client keeps a
    single renderer:
      {kind:"user", text}
      {kind:"assistant_text", text}
      {kind:"thinking", text}
      {kind:"tool", id, name, input, input_summary, ok, result}
    Tool results attach (by tool_use_id) to the open tool block.
    """
    open_tools = {}  # tool_use_id -> tool block dict
    try:
        fh = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        return
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue  # torn/malformed line — skip, never crash
            if not isinstance(obj, dict) or obj.get("isSidechain"):
                continue
            ltype = obj.get("type")
            if ltype == "user":
                msg = obj.get("message") or {}
                content = msg.get("content")
                blocks = (
                    [{"type": "text", "text": content}]
                    if isinstance(content, str)
                    else content if isinstance(content, list)
                    else []
                )
                for b in blocks:
                    if not isinstance(b, dict):
                        continue
                    btype = b.get("type")
                    if btype == "text":
                        text = strip_wrappers(b.get("text") or "")
                        if text:
                            yield {"kind": "user", "text": text}
                    elif btype == "tool_result":
                        tid = b.get("tool_use_id") or ""
                        tool = open_tools.get(tid)
                        if tool is None:
                            continue
                        rc = b.get("content")
                        if isinstance(rc, str):
                            rtext = rc
                        elif isinstance(rc, list):
                            rtext = "\n".join(
                                (x.get("text") or "")
                                for x in rc
                                if isinstance(x, dict) and x.get("type") == "text"
                            )
                        else:
                            rtext = ""
                        tool["ok"] = not bool(b.get("is_error"))
                        tool["result"] = rtext[:MAX_TOOL_OUTPUT_CHARS]
            elif ltype == "assistant":
                msg = obj.get("message") or {}
                for b in msg.get("content") or []:
                    if not isinstance(b, dict):
                        continue
                    btype = b.get("type")
                    if btype == "text":
                        text = b.get("text") or ""
                        if text.strip():
                            yield {"kind": "assistant_text", "text": text}
                    elif btype == "thinking":
                        text = b.get("thinking") or ""
                        if text.strip():
                            yield {"kind": "thinking", "text": text}
                    elif btype == "tool_use":
                        name = b.get("name") or "tool"
                        input_obj = b.get("input")
                        if not isinstance(input_obj, dict):
                            input_obj = {}
                        try:
                            input_str = json.dumps(input_obj, ensure_ascii=False)
                        except Exception:
                            input_str = "{}"
                        tool = {
                            "kind": "tool",
                            "id": b.get("id") or "",
                            "name": name,
                            "input": input_str[:MAX_TOOL_INPUT_CHARS],
                            "input_summary": _tool_summary(name, input_obj),
                            "ok": None,
                            "result": None,
                        }
                        open_tools[tool["id"]] = tool
                        yield tool
            # everything else (attachment, api-request*, queue-operation,
            # ai-title, cost-state, last-prompt, system, ...) is skipped


def _scan_session_file(path):
    """Single streaming pass for sidebar metadata. Returns an entry dict."""
    first_user_text = ""
    ai_title = ""
    cost = None
    msg_count = 0
    try:
        fh = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        return None
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if not isinstance(obj, dict) or obj.get("isSidechain"):
                continue
            ltype = obj.get("type")
            if ltype == "ai-title":
                ai_title = obj.get("aiTitle") or ai_title
            elif ltype == "cost-state":
                c = obj.get("totalCostUSD")
                if isinstance(c, (int, float)):
                    cost = c
            elif ltype == "user" and not first_user_text:
                msg = obj.get("message") or {}
                text = strip_wrappers(_text_from_content(msg.get("content")))
                if text:
                    first_user_text = text
            if first_user_text:
                # keep scanning cheaply: only ai-title/cost-state matter now
                pass
    # message count: cheap second metric — number of user text blocks
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if '"type":"user"' not in line and '"type": "user"' not in line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if not isinstance(obj, dict) or obj.get("isSidechain"):
                    continue
                msg = obj.get("message") or {}
                if strip_wrappers(_text_from_content(msg.get("content"))):
                    msg_count += 1
    except OSError:
        pass
    title = ai_title or (first_user_text[:60] if first_user_text else "") or "New chat"
    return {
        "title": title,
        "preview": first_user_text[:100],
        "cost": cost,
        "message_count": msg_count,
    }


_SESSION_CACHE = {}
_SESSION_CACHE_LOCK = threading.Lock()


def index_sessions(cwd):
    """List sessions for cwd, newest first. mtime-keyed cache; zero CLI calls."""
    sdir = session_dir_for(cwd)
    out = []
    try:
        entries = os.scandir(sdir)
    except OSError:
        return out
    with entries:
        for ent in entries:
            if not ent.name.endswith(".jsonl") or not ent.is_file():
                continue  # skip subagent directories and noise
            try:
                st = ent.stat()
            except OSError:
                continue
            cache_key = ent.path
            cached = _SESSION_CACHE.get(cache_key)
            if cached and cached["mtime"] == st.st_mtime and cached["size"] == st.st_size:
                meta = cached["meta"]
            else:
                meta = _scan_session_file(ent.path)
                if meta is None:
                    continue
                with _SESSION_CACHE_LOCK:
                    _SESSION_CACHE[cache_key] = {
                        "mtime": st.st_mtime,
                        "size": st.st_size,
                        "meta": meta,
                    }
            out.append(
                {
                    "id": ent.name[: -len(".jsonl")],
                    "title": meta["title"],
                    "preview": meta["preview"],
                    "cost": meta["cost"],
                    "message_count": meta["message_count"],
                    "mtime_epoch": int(st.st_mtime),
                    "mtime_iso": time.strftime(
                        "%Y-%m-%d %H:%M", time.localtime(st.st_mtime)
                    ),
                }
            )
    out.sort(key=lambda s: s["mtime_epoch"], reverse=True)
    return out

# ---------------------------------------------------------------------------
# Turn manager — one headless claude process per user message
# ---------------------------------------------------------------------------

class Turn:
    def __init__(self, requested_session_id):
        self.requested_session_id = requested_session_id
        self.cli_session_id = None
        self.proc = None
        self.events = collections.deque(maxlen=4096)
        self.finished = False
        self.cancelled = False
        self.emitted_turn_end = False
        self.partial_mode = False          # seen a stream_event line
        self.seen_tool_ids = set()
        self.open_tools = {}               # content-block index -> pending tool
        self.model = None
        self.started = time.time()
        self.watchdog = None
        self.stderr_tail = collections.deque(maxlen=50)

    def emit(self, ev):
        self.events.append(ev)

    def finish(self):
        if self.finished:
            return
        self.finished = True
        if self.watchdog:
            self.watchdog.cancel()
        with TURNS_LOCK:
            for key, t in list(TURNS.items()):
                if t is self:
                    del TURNS[key]


def build_argv(model, full_access, session_id):
    argv = [
        APP_STATE["cli_bin"],
        "-p",
        "--output-format", "stream-json",
        "--verbose",                       # required by stream-json here
        "--include-partial-messages",      # token-level streaming
        "--model", model,
    ]
    if full_access:
        argv.append("--dangerously-skip-permissions")
    else:
        argv += [
            "--allowedTools", READONLY_ALLOWED,
            "--disallowedTools", READONLY_DISALLOWED,
            "--permission-prompts", "none",  # auto-deny instead of hanging
        ]
    if session_id:
        argv += ["--resume", session_id]
    return argv


def _content_block_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            (b.get("text") or "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _handle_stream_event(turn, ev):
    """Map a stream_event line (partial deltas) to browser events."""
    etype = ev.get("type")
    if etype == "content_block_start":
        block = ev.get("content_block") or {}
        if block.get("type") == "tool_use":
            turn.seen_tool_ids.add(block.get("id") or "")
            turn.open_tools[ev.get("index")] = {
                "id": block.get("id") or "",
                "name": block.get("name") or "tool",
                "json_buf": [],
            }
    elif etype == "content_block_delta":
        delta = ev.get("delta") or {}
        dtype = delta.get("type")
        if dtype == "text_delta":
            text = delta.get("text") or ""
            if text:
                turn.emit({"t": "text_delta", "text": text})
        elif dtype == "thinking_delta":
            text = delta.get("thinking") or ""
            if text:
                turn.emit({"t": "thinking_delta", "text": text})
        elif dtype == "input_json_delta":
            pending = turn.open_tools.get(ev.get("index"))
            if pending is not None:
                pending["json_buf"].append(delta.get("partial_json") or "")
    elif etype == "content_block_stop":
        pending = turn.open_tools.pop(ev.get("index"), None)
        if pending is not None:
            raw = "".join(pending["json_buf"])
            try:
                input_obj = json.loads(raw) if raw.strip() else {}
            except Exception:
                input_obj = {}
            if not isinstance(input_obj, dict):
                input_obj = {}
            turn.seen_tool_ids.add(pending["id"])
            turn.emit(
                {
                    "t": "tool_start",
                    "id": pending["id"],
                    "name": pending["name"],
                    "summary": _tool_summary(pending["name"], input_obj),
                }
            )


def _handle_assistant_line(turn, obj):
    """Full assistant message. In partial mode text/thinking already streamed;
    only emit tool_use blocks that slipped past stream events."""
    msg = obj.get("message") or {}
    for b in msg.get("content") or []:
        if not isinstance(b, dict):
            continue
        btype = b.get("type")
        if btype == "tool_use":
            bid = b.get("id") or ""
            if bid in turn.seen_tool_ids:
                continue
            turn.seen_tool_ids.add(bid)
            input_obj = b.get("input") if isinstance(b.get("input"), dict) else {}
            turn.emit(
                {
                    "t": "tool_start",
                    "id": bid,
                    "name": b.get("name") or "tool",
                    "summary": _tool_summary(b.get("name") or "tool", input_obj),
                }
            )
        elif btype == "text" and not turn.partial_mode:
            text = b.get("text") or ""
            if text:
                turn.emit({"t": "text_delta", "text": text})
        elif btype == "thinking" and not turn.partial_mode:
            text = b.get("thinking") or ""
            if text:
                turn.emit({"t": "thinking_delta", "text": text})
                turn.emit({"t": "thinking_end"})


def _handle_user_line(turn, obj):
    """Tool results arrive as user messages in stream-json."""
    msg = obj.get("message") or {}
    content = msg.get("content")
    blocks = content if isinstance(content, list) else []
    for b in blocks:
        if not isinstance(b, dict) or b.get("type") != "tool_result":
            continue
        text = _content_block_text(b.get("content"))
        turn.emit(
            {
                "t": "tool_end",
                "id": b.get("tool_use_id") or "",
                "ok": not bool(b.get("is_error")),
                "output_preview": text[:MAX_TOOL_OUTPUT_CHARS],
            }
        )


def _handle_result_line(turn, obj):
    if turn.emitted_turn_end:
        return
    turn.emitted_turn_end = True
    usage = obj.get("usage") or {}
    is_err = bool(obj.get("is_error")) or obj.get("subtype") not in (None, "success")
    turn.emit(
        {
            "t": "turn_end",
            "reason": "error" if is_err else "done",
            "cost_usd": obj.get("total_cost_usd"),
            "duration_ms": obj.get("duration_ms"),
            "tokens": {
                "input": usage.get("input_tokens"),
                "output": usage.get("output_tokens"),
            },
            "model": obj.get("model") or turn.model,
            "error": obj.get("result") if is_err else None,
        }
    )


def pump_stdout(turn):
    """Drain the CLI child to EOF, mapping lines to browser events.

    Runs on its own thread so a vanished browser can never fill the child's
    stdout pipe and wedge the session: the turn always completes server-side
    and lands in the CLI's own session JSONL, where a reload recovers it.
    """
    proc = turn.proc
    try:
        for raw in proc.stdout:
            line = raw.strip()
            if not line:
                continue
            if len(line) > 32 * 1024 * 1024:  # absurd line guard
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if not isinstance(obj, dict):
                continue
            otype = obj.get("type")
            if otype == "system" and obj.get("subtype") == "init":
                turn.cli_session_id = obj.get("session_id")
                turn.model = obj.get("model")
                if turn.cli_session_id:
                    with TURNS_LOCK:
                        TURNS.setdefault(turn.cli_session_id, turn)
                turn.emit(
                    {
                        "t": "session",
                        "session_id": turn.cli_session_id,
                        "model": turn.model,
                    }
                )
            elif otype == "stream_event":
                turn.partial_mode = True
                _handle_stream_event(turn, obj.get("event") or {})
            elif otype == "assistant":
                _handle_assistant_line(turn, obj)
            elif otype == "user":
                _handle_user_line(turn, obj)
            elif otype == "result":
                _handle_result_line(turn, obj)
            # unknown types are ignored (version-drift tolerance)
    except Exception:
        pass
    finally:
        try:
            proc.wait(timeout=10)
        except Exception:
            pass
        if not turn.emitted_turn_end:
            turn.emitted_turn_end = True
            rc = proc.returncode
            if turn.cancelled:
                reason = "cancelled"
            elif rc == 0:
                reason = "done"
            else:
                reason = "error"
            ev = {
                "t": "turn_end",
                "reason": reason,
                "cost_usd": None,
                "duration_ms": int((time.time() - turn.started) * 1000),
                "tokens": {"input": None, "output": None},
                "model": turn.model,
            }
            if reason == "error":
                err_tail = " ".join(turn.stderr_tail)[-500:]
                ev["error"] = f"claude exited with code {rc}. {err_tail}".strip()
            turn.emit(ev)
        turn.emit({"t": "turn_done"})
        turn.finish()
        TURN_SEMAPHORE.release()  # paired with acquire() in start_turn


def drain_stderr(turn):
    try:
        for raw in turn.proc.stderr:
            turn.stderr_tail.append(raw.decode("utf-8", "replace"))
    except Exception:
        pass


def kill_process_group(proc, sig):
    try:
        os.killpg(os.getpgid(proc.pid), sig)
    except (ProcessLookupError, PermissionError):
        try:
            proc.send_signal(sig)
        except Exception:
            pass


def start_turn(message, model, full_access, session_id):
    """Spawn the CLI and wire up threads. Returns (turn, error_string)."""
    if not APP_STATE["cli_bin"]:
        return None, "claude CLI not found. Install it or set CLAUDE_WEB_CLAUDE_BIN."
    if not TURN_SEMAPHORE.acquire(blocking=False):
        return None, "Another turn is already running (max 2 concurrent)."
    turn = Turn(session_id)
    argv = build_argv(model, full_access, session_id)
    try:
        proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=APP_STATE["cwd"],
            start_new_session=True,   # own process group → clean killpg
        )
    except OSError as exc:
        TURN_SEMAPHORE.release()
        return None, f"Failed to launch claude: {exc}"
    turn.proc = proc
    with TURNS_LOCK:
        if session_id:
            TURNS[session_id] = turn
    turn.watchdog = threading.Timer(
        TURN_WATCHDOG_SECS, _watchdog_kill, args=(turn,)
    )
    turn.watchdog.daemon = True
    turn.watchdog.start()
    threading.Thread(target=pump_stdout, args=(turn,), daemon=True).start()
    threading.Thread(target=drain_stderr, args=(turn,), daemon=True).start()

    def write_stdin():
        try:
            proc.stdin.write(message.encode("utf-8"))
            proc.stdin.close()
        except Exception:
            pass

    threading.Thread(target=write_stdin, daemon=True).start()
    return turn, None


def _watchdog_kill(turn):
    turn.emit({"t": "error", "message": "Turn exceeded 30 minutes; killed."})
    turn.cancelled = True
    if turn.proc and turn.proc.poll() is None:
        kill_process_group(turn.proc, signal.SIGKILL)


def cancel_turn(session_id):
    with TURNS_LOCK:
        turn = TURNS.get(session_id)
    if turn is None:
        return False
    turn.cancelled = True
    if turn.proc and turn.proc.poll() is None:
        kill_process_group(turn.proc, signal.SIGTERM)
        threading.Thread(target=_escalate_kill, args=(turn,), daemon=True).start()
    return True


def _escalate_kill(turn):
    time.sleep(2.0)
    proc = turn.proc
    if proc and proc.poll() is None:
        kill_process_group(proc, signal.SIGKILL)

# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
}

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; "
    "img-src 'self' data:; connect-src 'self'"
)


class Handler(BaseHTTPRequestHandler):
    server_version = "claude-web/1.0"
    protocol_version = "HTTP/1.1"

    # -- plumbing ----------------------------------------------------------

    def log_message(self, fmt, *args):
        sys.stderr.write(
            "%s - %s\n" % (self.address_string(), fmt % args)
        )

    def _host_ok(self):
        host = (self.headers.get("Host") or "").strip()
        if not host:
            return False
        if APP_STATE["public"]:
            # Bound beyond loopback: Basic auth is the gate, so accept any
            # Host authority the user reaches us by (public IP, DNS name) —
            # but Origin must still match it exactly (same-origin only).
            return True
        p = APP_STATE["port"]
        hosts = {f"localhost:{p}", f"127.0.0.1:{p}"}
        if APP_STATE["host"] not in ("0.0.0.0", "::"):
            hosts.add(f"{APP_STATE['host']}:{p}")
        return host in hosts

    def _origin_ok(self, require_header):
        """Cross-site pages can neither spoof Origin nor add the custom
        X-Requested-With header without a CORS preflight we never answer."""
        origin = self.headers.get("Origin")
        if origin and origin != "null":
            m = re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)$", origin)
            if not m or m.group(1).lower() != (
                self.headers.get("Host") or ""
            ).strip().lower():
                return False
        if require_header and self.headers.get("X-Requested-With") != "claude-web":
            return False
        return True

    def _auth_ok(self):
        if not AUTH["user"]:
            return True
        header = self.headers.get("Authorization") or ""
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:].strip(), validate=True).decode(
                "utf-8", "replace"
            )
        except Exception:
            return False
        user, _, password = decoded.partition(":")
        ok_user = hmac.compare_digest(
            user.encode("utf-8"), AUTH["user"].encode("utf-8")
        )
        ok_pw = hmac.compare_digest(
            password.encode("utf-8"), AUTH["password"].encode("utf-8")
        )
        if not (ok_user and ok_pw):
            time.sleep(0.5)  # slow brute-force attempts a little
        return ok_user and ok_pw

    def _require_auth(self):
        if self._auth_ok():
            return True
        self.close_connection = True
        body = json.dumps({"error": "authentication required"}).encode("utf-8")
        try:
            self.send_response(401)
            self.send_header(
                "WWW-Authenticate", 'Basic realm="claude-web", charset="UTF-8"'
            )
            self.send_header("Connection", "close")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        return False

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        return self.rfile.read(length)

    def send_json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def send_text(self, text, code, content_type="text/plain; charset=utf-8"):
        data = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    # -- methods -----------------------------------------------------------

    def do_GET(self):
        if not self._require_auth():
            return
        if not self._host_ok():
            return self.send_text("Forbidden", 403)
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/"):
            return self.route_api_get(path)
        return self.serve_static(path)

    def do_POST(self):
        if not self._require_auth():
            return
        if not self._host_ok():
            return self.send_text("Forbidden", 403)
        path = self.path.split("?", 1)[0]
        if path.startswith("/api/"):
            if not self._origin_ok(require_header=True):
                self.close_connection = True  # request body not yet read
                return self.send_text("Forbidden", 403)
            if path == "/api/chat":
                return self.api_chat()
            if path == "/api/cancel":
                return self.api_cancel()
            return self.send_text("Not found", 404)
        return self.send_text("Not found", 404)

    def do_PUT(self):
        self.close_connection = True  # body never read; don't desync keep-alive
        self.send_text("Method not allowed", 405)

    do_DELETE = do_PUT
    do_PATCH = do_PUT

    # -- static ------------------------------------------------------------

    def serve_static(self, path):
        if path == "/":
            path = "/index.html"
        rel = path.lstrip("/")
        root = os.path.realpath(STATIC_DIR)
        target = os.path.realpath(os.path.join(root, rel))
        if target != root and not target.startswith(root + os.sep):
            return self.send_text("Not found", 404)
        if not os.path.isfile(target):
            return self.send_text("Not found", 404)
        ext = os.path.splitext(target)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        try:
            with open(target, "rb") as fh:
                data = fh.read()
        except OSError:
            return self.send_text("Not found", 404)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if ext == ".html":
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("Cache-Control", "no-cache")
        elif rel.startswith("vendor/"):
            self.send_header("Cache-Control", "max-age=86400")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # -- GET api -----------------------------------------------------------

    def route_api_get(self, path):
        if path == "/api/health":
            return self.api_health()
        if path == "/api/config":
            return self.api_config()
        if path == "/api/sessions":
            return self.api_sessions()
        m = re.match(r"^/api/sessions/([0-9a-f-]{36})/messages$", path)
        if m:
            return self.api_messages(m.group(1))
        return self.send_json({"error": "not found"}, 404)

    def api_health(self):
        cli = APP_STATE["cli_bin"]
        return self.send_json(
            {
                "ok": bool(cli),
                "cli_path": cli,
                "cli_version": APP_STATE["cli_version"],
                "cwd": APP_STATE["cwd"],
                "sessions_dir": session_dir_for(APP_STATE["cwd"]),
                "active_turns": len(TURNS),
            }
        )

    def api_config(self):
        env_model = os.environ.get("ANTHROPIC_MODEL", "").strip()
        default_model = env_model if env_model in MODEL_OPTIONS else "auto"
        return self.send_json(
            {
                "models": MODEL_OPTIONS,
                "default_model": default_model,
                "full_access_default": False,
                "readonly_allowed": READONLY_ALLOWED.split(","),
            }
        )

    def api_sessions(self):
        return self.send_json({"sessions": index_sessions(APP_STATE["cwd"])})

    def api_messages(self, session_id):
        path = session_path_for(APP_STATE["cwd"], session_id)
        if not path or not os.path.isfile(path):
            return self.send_json({"error": "session not found"}, 404)
        blocks = list(iter_session_blocks(path))
        total = len(blocks)
        truncated = total > MAX_REPLAY_BLOCKS
        shown = blocks[-MAX_REPLAY_BLOCKS:] if truncated else blocks
        meta = _scan_session_file(path) or {}
        return self.send_json(
            {
                "session_id": session_id,
                "title": meta.get("title", "New chat"),
                "blocks": shown,
                "total_blocks": total,
                "truncated": truncated,
                "cost": meta.get("cost"),
            }
        )

    # -- POST api ----------------------------------------------------------

    def api_cancel(self):
        body = self._read_body()
        if body is None:
            return self.send_json({"error": "bad body"}, 400)
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception:
            return self.send_json({"error": "bad json"}, 400)
        session_id = data.get("session_id") or ""
        if not SESSION_ID_RE.match(session_id):
            return self.send_json({"error": "bad session id"}, 400)
        if cancel_turn(session_id):
            return self.send_json({"cancelled": True})
        return self.send_json({"cancelled": False, "error": "no active turn"}, 404)

    def api_chat(self):
        body = self._read_body()
        if body is None:
            return self.send_json({"error": "bad or oversized body"}, 400)
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception:
            return self.send_json({"error": "bad json"}, 400)
        message = data.get("message")
        if not isinstance(message, str) or not message.strip():
            return self.send_json({"error": "message required"}, 400)
        if len(message) > 200_000:
            return self.send_json({"error": "message too long"}, 400)
        session_id = data.get("session_id") or None
        if session_id is not None and not SESSION_ID_RE.match(session_id):
            return self.send_json({"error": "bad session id"}, 400)
        model = data.get("model") or "auto"
        if model not in MODEL_OPTIONS:
            return self.send_json({"error": "bad model"}, 400)
        full_access = bool(data.get("full_access"))

        with TURNS_LOCK:
            if session_id and session_id in TURNS:
                return self.send_json(
                    {"error": "busy", "detail": "a turn is already running in this session"},
                    409,
                )
        turn, err = start_turn(message, model, full_access, session_id)
        if err:
            return self.send_json({"error": err}, 503)

        # Stream the turn's event deque as SSE. No Content-Length, no chunked
        # encoding: the connection close marks the end of the body.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()

        cursor = 0
        last_write = time.time()
        try:
            while True:
                fresh = list(turn.events)[cursor:]
                if fresh:
                    for ev in fresh:
                        frame = (
                            f"event: {ev.get('t', 'msg')}\n"
                            f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                        )
                        self.wfile.write(frame.encode("utf-8"))
                    cursor += len(fresh)
                    self.wfile.flush()
                    last_write = time.time()
                elif not turn.finished and time.time() - last_write > SSE_PING_SECS:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_write = time.time()
                if turn.finished and cursor >= len(turn.events):
                    break
                if not fresh and not turn.finished:
                    time.sleep(0.04)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # client gone; pump thread finishes the turn regardless

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="claude-web: web UI for the Claude Code CLI")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--cwd", default=os.getcwd(), help="working directory for sessions")
    ap.add_argument(
        "--insecure-no-auth",
        action="store_true",
        help="permit a non-loopback bind even without credentials set",
    )
    args = ap.parse_args()

    APP_STATE["host"] = args.host
    APP_STATE["port"] = args.port
    APP_STATE["cwd"] = os.path.abspath(args.cwd)
    auth_ready = load_auth_config()
    APP_STATE["public"] = args.host not in ("127.0.0.1", "localhost", "::1")
    if APP_STATE["public"] and not auth_ready and not args.insecure_no_auth:
        sys.exit(
            "refusing to bind beyond loopback without credentials.\n"
            "  set CLAUDE_WEB_USER and CLAUDE_WEB_PASSWORD (or\n"
            "  CLAUDE_WEB_PASSWORD_FILE), or pass --insecure-no-auth."
        )
    APP_STATE["cli_bin"] = find_claude_bin()
    if APP_STATE["cli_bin"]:
        APP_STATE["cli_version"] = detect_cli_version(APP_STATE["cli_bin"])

    print(f"claude-web  http://{args.host}:{args.port}")
    print(f"  cwd       {APP_STATE['cwd']}")
    if auth_ready:
        print(f"  auth      Basic auth required (user: {AUTH['user']})")
    else:
        print("  auth      none — loopback only")
    if APP_STATE["cli_bin"]:
        print(f"  claude    {APP_STATE['cli_bin']} ({APP_STATE['cli_version'] or 'version unknown'})")
    else:
        print(
            "  claude    NOT FOUND — install the CLI or set CLAUDE_WEB_CLAUDE_BIN; "
            "the UI will still serve but cannot run turns.",
            file=sys.stderr,
        )
    print(f"  sessions  {session_dir_for(APP_STATE['cwd'])}")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()

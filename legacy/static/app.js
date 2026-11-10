/* claude-web frontend. Vanilla ES2020, no build step.
 * Consumes SSE-over-POST from /api/chat via fetch + ReadableStream. */
"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  sessionId: null,        // current chat session (CLI session id)
  streaming: false,       // a turn is in flight
  fullAccess: false,
  model: "auto",
  turnFetch: null,        // AbortController for the in-flight chat POST
  currentController: null // event source for the active streamed turn
};

const els = {};

function $(id) { return document.getElementById(id); }

const refs = [
  "app", "sidebar", "collapse-btn", "expand-btn", "new-chat", "session-list",
  "cli-status", "model-select", "mode-pill", "mode-label", "scroll", "greeting",
  "banner", "chat", "load-earlier-wrap", "load-earlier", "composer", "input",
  "send-btn", "send-icon", "stop-icon", "cwd-hint", "confirm-full-access",
  "confirm-ok", "confirm-cancel", "scroll-bottom-btn-wrap", "scroll-bottom-btn",
  "greeting-text"
];
refs.forEach((id) => { els[id] = $(id); });

// ---------------------------------------------------------------------------
// Markdown: marked + DOMPurify, escape-first fallback if vendored files
// are missing (offline path).
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function renderFallbackMarkdown(src) {
  const out = [];
  const lines = src.split("\n");
  let inCode = false;
  let codeLang = "";
  let codeBuf = [];
  let listType = null; // "ul" | "ol"
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };
  for (const raw of lines) {
    const fence = raw.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        inCode = false; codeBuf = [];
      } else { inCode = true; codeLang = fence[1]; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }
    const heading = raw.match(/^(#{1,4})\s+(.*)$/);
    const li = raw.match(/^\s*[-*]\s+(.*)$/);
    const oli = raw.match(/^\s*\d+[.)]\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (li) {
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${inline(li[1])}</li>`);
    } else if (oli) {
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${inline(oli[1])}</li>`);
    } else if (!raw.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(raw)}</p>`);
    }
  }
  if (inCode && codeBuf.length) {
    out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  if (listType) out.push(`</${listType}>`);
  return out.join("\n");
}

function renderMarkdown(text) {
  try {
    if (window.marked && window.DOMPurify) {
      const html = marked.parse(text, { breaks: true, async: false });
      return DOMPurify.sanitize(html, {
        ADD_ATTR: ["target"],
        FORCE_BODY: true
      });
    }
  } catch (e) { /* fall through */ }
  return renderFallbackMarkdown(text);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function timeAgo(epochSecs) {
  const d = Date.now() / 1000 - epochSecs;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}d ago`;
  return new Date(epochSecs * 1000).toLocaleDateString();
}

function fmtCost(usd) {
  if (usd == null || isNaN(usd)) return null;
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(usd < 10 ? 2 : 2)}`;
}

function fmtTokens(n) {
  if (n == null) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${n} tok`;
}

function greetingWord() {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function setBanner(text) {
  if (text) {
    els.banner.textContent = text;
    els.banner.classList.remove("hidden");
  } else {
    els.banner.classList.add("hidden");
  }
}

function atBottom() {
  return els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < 120;
}
function scrollToBottom(force) {
  if (force || atBottom()) els.scroll.scrollTop = els.scroll.scrollHeight;
}

// ---------------------------------------------------------------------------
// Assistant message rendering (streaming + replay share this)
// ---------------------------------------------------------------------------

function makeAvatarSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.innerHTML = '<path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2z"/>';
  return svg;
}

function updateThinkingLabel(detailsEl, stateLabel) {
  const summary = detailsEl.querySelector("summary .t-label");
  if (summary) summary.textContent = stateLabel;
}

/**
 * AssistantMsg accumulates one assistant turn's blocks in DOM order.
 * Used live (deltas append) and in replay (full texts).
 */
class AssistantMsg {
  constructor(chatEl) {
    this.msgEl = document.createElement("div");
    this.msgEl.className = "msg msg-assistant";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.appendChild(makeAvatarSvg());
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "msg-body";
    this.msgEl.appendChild(avatar);
    this.msgEl.appendChild(this.bodyEl);
    chatEl.appendChild(this.msgEl);
    this.pending = null;      // text currently streaming into an open markdown el
    this.renderTimer = null;
    this.openTools = new Map(); // tool id -> tool el
    this.openThinking = null;
    this.footer = null;
  }

  _flushPending() {
    if (this.pending) {
      this.pending.el.innerHTML = renderMarkdown(this.pending.buf);
      this.pending = null;
    }
  }

  _scheduleRender(el, getText) {
    // coalesce re-renders to ~10/s
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      el.innerHTML = renderMarkdown(getText());
      scrollToBottom(false);
    }, 90);
  }

  addTextDelta(text) {
    if (this.openThinking) {
      updateThinkingLabel(this.openThinking, "Thought for a moment");
      this.openThinking = null;
    }
    if (!this.pending || this.pending.el !== this._lastTextEl()) {
      this._flushPending();
      const el = document.createElement("div");
      el.className = "markdown";
      this.bodyEl.appendChild(el);
      this.pending = { el, buf: "" };
      this._lastText = el;
    }
    this.pending.buf += text;
    const el = this.pending.el;
    const buf = this.pending.buf;
    this._scheduleRender(el, () => buf);
  }

  _lastTextEl() { return this._lastText || null; }

  addThinkingDelta(text) {
    if (!this.openThinking) {
      this._flushPending();
      const details = document.createElement("details");
      details.className = "thinking";
      details.innerHTML =
        '<summary><svg class="chev" viewBox="0 0 24 24" width="12" height="12"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span class="t-label">Thinking…</span></summary>' +
        '<div class="thinking-body"></div>';
      this.bodyEl.appendChild(details);
      this.openThinking = details;
      details.open = false;
    }
    this.openThinking.querySelector(".thinking-body").appendChild(
      document.createTextNode(text)
    );
  }

  endThinking() {
    if (this.openThinking) {
      updateThinkingLabel(this.openThinking, "Thought for a moment");
      this.openThinking = null;
    }
  }

  addTool(id, name, summary) {
    this.endThinking();
    this._flushPending();
    const tool = document.createElement("div");
    tool.className = "tool";
    tool.dataset.toolId = id;
    tool.innerHTML =
      '<button type="button" class="tool-row">' +
      '<span class="tool-badge"></span>' +
      '<span class="tool-summary"></span>' +
      '<svg class="tool-chev" viewBox="0 0 24 24" width="14" height="14"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</button>' +
      '<div class="tool-detail"><div class="detail-label">Input</div><pre class="tool-input"></pre></div>';
    tool.querySelector(".tool-badge").textContent = name;
    tool.querySelector(".tool-summary").textContent = summary || "";
    tool.querySelector(".tool-row").addEventListener("click", () => {
      tool.classList.toggle("open");
    });
    this.bodyEl.appendChild(tool);
    if (id) this.openTools.set(id, tool);
    scrollToBottom(false);
    return tool;
  }

  toolResult(id, ok, preview) {
    let tool = (id && this.openTools.get(id)) || null;
    if (!tool) {
      const all = this.msgEl.querySelectorAll(".tool:not(.has-result)");
      tool = all[all.length - 1] || null;
    }
    if (!tool) return;
    tool.classList.add("has-result");
    if (!ok) tool.classList.add("err");
    const detail = tool.querySelector(".tool-detail");
    if (preview) {
      const label = document.createElement("div");
      label.className = "detail-label";
      label.textContent = ok ? "Result" : "Error";
      const pre = document.createElement("pre");
      pre.className = "tool-output";
      pre.textContent = preview;
      detail.appendChild(label);
      detail.appendChild(pre);
    }
  }

  addError(text) {
    this._flushPending();
    const el = document.createElement("div");
    el.className = "error-line";
    el.textContent = text;
    this.bodyEl.appendChild(el);
  }

  finish(reason, meta) {
    this.endThinking();
    this._flushPending();
    if (this.renderTimer) { clearTimeout(this.renderTimer); this.renderTimer = null; }
    if (meta && (meta.tokens || meta.cost || meta.duration)) {
      const f = document.createElement("div");
      f.className = "turn-footer";
      const parts = [];
      if (meta.tokens) parts.push(meta.tokens);
      if (meta.cost) parts.push(meta.cost);
      if (meta.duration) parts.push(meta.duration);
      f.textContent = parts.join(" · ");
      this.bodyEl.appendChild(f);
    }
    if (reason === "cancelled") {
      const el = document.createElement("div");
      el.className = "turn-footer";
      el.textContent = "stopped by user";
      this.bodyEl.appendChild(el);
    } else if (reason === "error" && meta && meta.errorText) {
      this.addError(meta.errorText);
    }
  }
}

// ---------------------------------------------------------------------------
// Chat area management
// ---------------------------------------------------------------------------

function clearChat() {
  els.chat.innerHTML = "";
}

function hideGreeting() {
  els.greeting.classList.add("hidden");
}

function showGreetingIfEmpty() {
  if (!els.chat.children.length) {
    els.greeting.classList.remove("hidden");
    els["greeting-text"].textContent = greetingWord();
  }
}

function addUserMessage(text) {
  hideGreeting();
  const wrap = document.createElement("div");
  wrap.className = "msg msg-user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  els.chat.appendChild(wrap);
  scrollToBottom(true);
}

function newAssistantMsg() {
  return new AssistantMsg(els.chat);
}

function renderReplayBlocks(blocks) {
  for (const b of blocks) {
    if (b.kind === "user") {
      addUserMessage(b.text);
    } else if (b.kind === "assistant_text") {
      const m = newAssistantMsg();
      m.addTextDelta(b.text);
      m.finish("done", null);
    } else if (b.kind === "thinking") {
      const m = newAssistantMsg();
      m.addThinkingDelta(b.text);
      updateThinkingLabel(m.openThinking, "Thought for a moment");
      m.openThinking.open = false;
      m.finish("done", null);
      m.openThinking = null;
    } else if (b.kind === "tool") {
      const m = newAssistantMsg();
      const tool = m.addTool(b.id, b.name, b.input_summary);
      tool.querySelector(".tool-input").textContent = b.input || "";
      if (b.result != null) m.toolResult(b.id, b.ok, b.result);
      m.finish("done", null);
    }
  }
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

async function loadSessions() {
  try {
    const res = await fetch("/api/sessions");
    if (!res.ok) return;
    const data = await res.json();
    renderSessionList(data.sessions || []);
  } catch (e) { /* server gone; ignore */ }
}

function renderSessionList(sessions) {
  els["session-list"].innerHTML = "";
  if (!sessions.length) {
    const d = document.createElement("div");
    d.className = "side-empty";
    d.textContent = "No previous chats";
    els["session-list"].appendChild(d);
    return;
  }
  for (const s of sessions) {
    const btn = document.createElement("button");
    btn.className = "session-item" + (s.id === state.sessionId ? " active" : " ");
    btn.dataset.sessionId = s.id;
    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = s.title || "New chat";
    const when = document.createElement("span");
    when.className = "session-time";
    when.textContent = timeAgo(s.mtime_epoch);
    btn.appendChild(title);
    btn.appendChild(when);
    btn.addEventListener("click", () => openSession(s.id));
    els["session-list"].appendChild(btn);
  }
}

function markActiveSession() {
  for (const btn of els["session-list"].children) {
    btn.classList.toggle("active", btn.dataset.sessionId === state.sessionId);
  }
}

async function openSession(id) {
  if (state.streaming) stopTurn();
  state.sessionId = id;
  markActiveSession();
  clearChat();
  hideGreeting();
  try {
    const res = await fetch(`/api/sessions/${id}/messages`);
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    renderReplayBlocks(data.blocks || []);
    if (data.truncated) {
      els["load-earlier-wrap"].classList.remove("hidden");
    } else {
      els["load-earlier-wrap"].classList.add("hidden");
    }
  } catch (e) {
    setBanner("Could not load that session's transcript.");
  }
  scrollToBottom(true);
  els.input.focus();
}

// ---------------------------------------------------------------------------
// Streaming turn (SSE over POST)
// ---------------------------------------------------------------------------

async function sendTurn() {
  const text = els.input.value.trim();
  if (!text || state.streaming) return;
  els.input.value = "";
  autosizeInput();

  addUserMessage(text);
  hideGreeting();
  setStreaming(true);

  const msg = newAssistantMsg();
  const dots = document.createElement("div");
  dots.className = "typing-dots";
  dots.innerHTML = "<span></span><span></span><span></span>";
  msg.bodyEl.appendChild(dots);

  let sawAnyContent = false;
  const removeDots = () => { dots.remove(); };
  let footerMeta = { tokens: null, cost: null, duration: null };

  try {
    const controller = new AbortController();
    state.turnFetch = controller;
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "claude-web"
      },
      body: JSON.stringify({
        session_id: state.sessionId,
        message: text,
        model: state.model,
        full_access: state.fullAccess
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).detail || (await res.json()).error || ""; } catch (e) {}
      throw new Error(detail || `server responded ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let frameBuf = "";
    let sawSession = false;

    const handleEvent = (data) => {
      let ev;
      try { ev = JSON.parse(data); } catch (e) { return; }
      switch (ev.t) {
        case "session":
          sawSession = true;
          if (ev.session_id) {
            const isNew = !state.sessionId;
            state.sessionId = ev.session_id;
            if (isNew) markActiveSession();
          }
          break;
        case "text_delta":
          if (!sawAnyContent) { removeDots(); sawAnyContent = true; }
          msg.addTextDelta(ev.text);
          break;
        case "thinking_delta":
          if (!sawAnyContent) { removeDots(); sawAnyContent = true; }
          msg.addThinkingDelta(ev.text);
          break;
        case "thinking_end":
          msg.endThinking();
          break;
        case "tool_start":
          if (!sawAnyContent) { removeDots(); sawAnyContent = true; }
          msg.addTool(ev.id, ev.name, ev.summary);
          break;
        case "tool_end":
          msg.toolResult(ev.id, ev.ok, ev.output_preview);
          break;
        case "turn_end": {
          footerMeta.tokens = fmtTokens(ev.tokens && ev.tokens.input != null
            ? (ev.tokens.input || 0) + (ev.tokens.output || 0) : null);
          footerMeta.cost = fmtCost(ev.cost_usd);
          footerMeta.duration = ev.duration_ms != null
            ? `${(ev.duration_ms / 1000).toFixed(1)}s` : null;
          if (ev.reason === "error") {
            footerMeta.errorText = ev.error || "The CLI reported an error.";
            msg.addError(footerMeta.errorText);
          }
          break;
        }
        case "error":
          if (!sawAnyContent) removeDots();
          msg.addError(ev.message || "Unknown error");
          break;
        case "turn_done":
          msg.finish("done", footerMeta);
          break;
      }
    };

    // parse SSE frames from the byte stream
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      frameBuf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = frameBuf.indexOf("\n\n")) !== -1) {
        const frame = frameBuf.slice(0, idx);
        frameBuf = frameBuf.slice(idx + 2);
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6));
        if (dataLines.length) handleEvent(dataLines.join("\n"));
      }
      scrollToBottom(false);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      // user pressed stop; server killpg → turn_end arrives via reload
      msg.finish("cancelled", null);
    } else {
      removeDots();
      msg.addError(err.message || "Request failed");
      msg.finish("error", null);
    }
  } finally {
    state.turnFetch = null;
    setStreaming(false);
    scrollToBottom(true);
    loadSessions();      // sidebar gains the new/updated session
    showGreetingIfEmpty();
  }
}

function stopTurn() {
  if (state.turnFetch) state.turnFetch.abort();
  if (state.sessionId) {
    fetch("/api/cancel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "claude-web"
      },
      body: JSON.stringify({ session_id: state.sessionId })
    }).catch(() => {});
  }
}

function setStreaming(on) {
  state.streaming = on;
  els.sendBtn = els["send-btn"];
  els["send-btn"].classList.toggle("stop", on);
  els["send-icon"].classList.toggle("hidden", on);
  els["stop-icon"].classList.toggle("hidden", !on);
  els["send-btn"].setAttribute("aria-label", on ? "Stop" : "Send");
  els.input.placeholder = on ? "Claude is working…" : "Reply to Claude…";
}

// ---------------------------------------------------------------------------
// Mode pill, model select, misc wiring
// ---------------------------------------------------------------------------

function applyMode() {
  els["mode-pill"].classList.toggle("full", state.fullAccess);
  els["mode-pill"].classList.toggle("readonly", !state.fullAccess);
  els["mode-label"].textContent = state.fullAccess ? "Full access" : "Read-only";
  els.app.dataset.mode = state.fullAccess ? "full" : "readonly";
}

els["mode-pill"].addEventListener("click", () => {
  if (!state.fullAccess) {
    els["confirm-full-access"].showModal();
  } else {
    state.fullAccess = false;
    applyMode();
  }
});

els["confirm-ok"].addEventListener("click", () => {
  state.fullAccess = true;
  applyMode();
  els["confirm-full-access"].close();
});

els["confirm-cancel"].addEventListener("click", () => {
  els["confirm-full-access"].close();
});

els["model-select"].addEventListener("change", (e) => {
  state.model = e.target.value;
});

els["new-chat"].addEventListener("click", () => {
  if (state.streaming) stopTurn();
  state.sessionId = null;
  markActiveSession();
  clearChat();
  showGreetingIfEmpty();
  els["load-earlier-wrap"].classList.add("hidden");
  setBanner("");
  els.input.focus();
});

els["collapse-btn"].addEventListener("click", () => {
  els.app.classList.add("collapsed");
  els["expand-btn"].classList.remove("hidden");
});
els["expand-btn"].addEventListener("click", () => {
  els.app.classList.remove("collapsed");
  els["expand-btn"].classList.add("hidden");
});

els["composer"].addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.streaming) stopTurn();
  else sendTurn();
});

els["scroll-bottom-btn"].addEventListener("click", () => scrollToBottom(true));

els["load-earlier"].addEventListener("click", () => {
  setBanner("Older messages are archived; this view shows the most recent 400 blocks.");
  els["load-earlier-wrap"].classList.add("hidden");
});

els["input"].addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (state.streaming) stopTurn();
    else sendTurn();
  }
});

function autosizeInput() {
  const t = els.input;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 180) + "px";
}
els["input"].addEventListener("input", autosizeInput);

els["scroll"].addEventListener("scroll", () => {
  els["scroll-bottom-btn-wrap"].classList.toggle("hidden", atBottom());
});

window.addEventListener("focus", loadSessions);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  els["greeting-text"].textContent = greetingWord();
  applyMode();

  try {
    const [healthRes, configRes] = await Promise.all([
      fetch("/api/health"),
      fetch("/api/config")
    ]);
    const health = await healthRes.json();
    const config = await configRes.json();

    for (const m of config.models || ["auto"]) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      els["model-select"].appendChild(opt);
    }
    state.model = config.default_model || "auto";
    els["model-select"].value = state.model;
    els["cwd-hint"].textContent = health.cwd || "";

    if (!health.ok) {
      setBanner(
        "claude CLI not found — install it, or set CLAUDE_WEB_CLAUDE_BIN and restart the server."
      );
      els["cli-status"].textContent = "claude: not found";
    } else {
      els["cli-status"].textContent = `claude ${health.cli_version || ""} · ${health.cwd}`;
    }
  } catch (e) {
    setBanner("Could not reach the server.");
  }

  await loadSessions();
  showGreetingIfEmpty();
  els.input.focus();
}

init();

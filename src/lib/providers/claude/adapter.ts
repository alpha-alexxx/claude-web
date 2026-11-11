import "server-only";
import type {
  ActiveSession,
  ModelInfo,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderInventory,
  SessionOpts,
} from "../types";
import { getEnv } from "../../env";
import {
  ClaudeSessionPool,
  type PoolGetOpts,
  type PoolSession,
} from "./session-pool";

/**
 * Claude adapter — the v1-complete implementation of the provider seam.
 * Everything UI-facing flows through the neutral TurnEvent contract; no
 * other module imports claude-agent-sdk.
 */

const CAPABILITIES: ProviderCapabilities = {
  interactiveToolPrompts: true,
  sessionResume: true,
  partialText: true,
  skills: "native",
  plugins: true,
};

/** Models offered in the picker (DEFAULT_MODEL=auto maps to no override). */
const DEFAULT_MODELS: ModelInfo[] = [
  { id: "sonnet", label: "Claude Sonnet (balanced)" },
  { id: "opus", label: "Claude Opus (most capable)" },
  { id: "haiku", label: "Claude Haiku (fastest)" },
  { id: "auto", label: "Auto (CLI default)" },
];

/**
 * "auto" is the UI's "no override" choice (DEFAULT_MODEL=auto), not a model id
 * the CLI knows. Translate it once, here, at the seam.
 */
function normalizeModel(model: string | null): string | null {
  if (!model) return null;
  return model === "auto" ? null : model;
}

/** Spawn opts are dead when the pool reuses a session — apply via setModel. */
function applyModelOnReuse(
  session: PoolSession,
  normalized: string | null,
  requested: string | null,
): void {
  // Only apply when the caller actually asked for a model this turn. A null
  // request means "keep whatever the session is already using" — clearing it
  // would stomp a model picked mid-conversation via the picker.
  if (requested === null) return;
  void session.setModel(normalized ?? undefined).catch(() => {
    // setModel is best-effort on reuse: the pool session may reject it when
    // a turn is in flight (CLI answers with an error result frame).
  });
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;
  readonly capabilities = CAPABILITIES;
  private readonly pool: ClaudeSessionPool;

  constructor(pool?: ClaudeSessionPool) {
    // Cap from env (MAX_CONCURRENT_TURNS). The pool never respawns per turn,
    // so each live conversation holds one ~1 GiB CLI process.
    this.pool = pool ?? new ClaudeSessionPool(undefined, getEnv().MAX_CONCURRENT_TURNS);
  }

  async inventory(): Promise<ProviderInventory> {
    // The SDK bundles its own CLI binary — nothing to detect at startup.
    // Credential source and version arrive on the first live session's init
    // frame; until then both stay unknown rather than guessed (ledgered:
    // no probe is cheaper than starting a session).
    const live = this.pool.health();
    return {
      id: this.id,
      installed: true,
      version: live.cliVersion,
      authed: live.apiKeySource === null ? null : true,
      reason: null,
      models: DEFAULT_MODELS,
    };
  }

  async startsSession(opts: SessionOpts): Promise<ActiveSession> {
    const model = normalizeModel(opts.model);
    const getOpts: PoolGetOpts = {
      cwd: opts.cwd,
      model,
      resumeSessionId: opts.resumeSessionId ?? null,
      onPermission: opts.onPermission,
      // Both are session-lifetime hooks: the pool binds them at CREATION and
      // never re-reads them, so they must not vary per turn. Dropping them
      // fails closed in a way the UI cannot show — every tool denies and
      // "allow for session" never takes effect.
      isToolAllowed: opts.isToolAllowed,
      onSessionClosed: opts.onSessionClosed,
    };
    const session = this.pool.get(opts.conversationId, getOpts);
    // On reuse, spawn options are dead: pool.get() ignores them for an
    // existing session. setModel is what makes the requested model real.
    applyModelOnReuse(session, model, opts.model);
    return {
      send: (text) => session.send(text),
      setModel: (model?: string) => session.setModel(model),
      interrupt: () => session.interrupt(),
      onEvent: (cb) => session.onEvent(cb),
      offEvent: (cb) => session.offEvent(cb),
      close: () => session.close(),
    };
  }

  /** Live pool session handle — used by the health check and resume logic. */
  poolSession(conversationId: string) {
    return this.pool.getIfLive(conversationId);
  }

  /** Stop-button path: peek without ever spawning a CLI process. */
  liveSession(conversationId: string): ActiveSession | null {
    const s = this.pool.getIfLive(conversationId);
    return s
      ? {
          send: (text) => s.send(text),
          setModel: (model?: string) => s.setModel(model),
          interrupt: () => s.interrupt(),
          onEvent: (cb) => s.onEvent(cb),
          offEvent: (cb) => s.offEvent(cb),
          close: () => s.close(),
        }
      : null;
  }

  size(): number {
    return this.pool.size();
  }

  async closeAll(): Promise<void> {
    await this.pool.closeAll();
  }
}

/**
 * Per-server singleton adapter. Node module graph is shared across route
 * handlers in dev and prod, so one pool instance is shared per process.
 */
let singleton: ClaudeAdapter | null = null;

export function getClaudeAdapter(): ClaudeAdapter {
  if (!singleton) singleton = new ClaudeAdapter();
  return singleton;
}

/** Test seam: drop the singleton so the next call rebuilds it. */
export function resetClaudeAdapterForTest(): void {
  singleton = null;
}

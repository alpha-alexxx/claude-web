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
import { detectOne, resolveOnPath, type Detection } from "../../integrations/detect";
import { integrationSpec } from "../../integrations/registry";
import { credentialEnvFor } from "../../integrations/credentials";
import { QoderSession, type QoderRunner } from "./session";
import { createQoderRunner } from "./runner";

/**
 * Qoder adapter — the fourth implementation of the provider seam.
 *
 * Three facts drive the whole shape:
 *
 *   1. `--permission-prompt-tool` is not a declared option in qodercli
 *      1.1.86 (it survives only through unknown-option tolerance), so there is
 *      no approval round trip to route here: `interactiveToolPrompts` is false
 *      and `--permission-mode bypass_permissions` is the boundary instead.
 *   2. The transport is Claude's stream-json dialect, so text DOES arrive as
 *      deltas: `partialText` is true, unlike Codex.
 *   3. Skills are bridged per skill into `~/.qoder/skills/<slug>` rather than
 *      read from the canonical store natively (see src/lib/skills/store.ts),
 *      so the capability is `managed`.
 *
 * Its process is per-TURN, so what persists per conversation is a
 * `QoderSession` object (session id + listeners), not an OS process. "Live
 * session" therefore means "a session object exists", so Stop still reaches
 * one that is idle.
 */

const CAPABILITIES: ProviderCapabilities = {
  interactiveToolPrompts: false,
  sessionResume: true,
  partialText: true,
  skills: "managed",
  plugins: false,
};

/**
 * Models offered in the picker. `qwen3.8-max` is the only model id the CLI
 * declares; "auto" is its own default sentinel and means "no -m override".
 */
const DEFAULT_MODELS: ModelInfo[] = [
  { id: "qwen3.8-max", label: "Qwen 3.8 Max" },
  { id: "auto", label: "Auto (CLI default)" },
];

/** "auto" is the UI's "no override" choice, not a value `-m` accepts. */
function normalizeModel(model: string | null): string | null {
  if (!model) return null;
  return model === "auto" ? null : model;
}

export interface QoderAdapterOpts {
  /** Spawn seam — production passes `createQoderRunner(resolveOnPath)`. */
  runner: QoderRunner;
  /** Cheap synchronous existence check so a start fails before any work. */
  findBinary: () => string | null;
  /** Provider credentials merged over the host env at spawn time. */
  credentials: () => Record<string, string>;
  /** Detection for `inventory()`; defaults to the real PATH probe. */
  detect?: () => Promise<Detection>;
  /** Max live session objects; defaults to MAX_CONCURRENT_TURNS. */
  capacity?: number;
}

interface Entry {
  session: QoderSession;
  active: ActiveSession;
}

export class QoderAdapter implements ProviderAdapter {
  readonly id = "qoder" as const;
  readonly capabilities = CAPABILITIES;
  private readonly opts: QoderAdapterOpts;
  private readonly capacity: number;
  private readonly sessions = new Map<string, Entry>();

  constructor(opts: QoderAdapterOpts) {
    this.opts = opts;
    this.capacity = opts.capacity ?? getEnv().MAX_CONCURRENT_TURNS;
    if (this.capacity < 1) throw new Error("qoder capacity must be >= 1");
  }

  async inventory(): Promise<ProviderInventory> {
    const detection = await (this.opts.detect ?? defaultDetect)();
    const installed = detection.status === "installed" || detection.status === "bundled";
    return {
      id: this.id,
      installed,
      version: detection.version,
      // Qoder is a plain binary: whether this deployment has a credential for
      // it is knowable without starting a turn.
      authed: Object.keys(this.opts.credentials()).length > 0,
      reason: detection.reason,
      models: DEFAULT_MODELS,
    };
  }

  async startsSession(opts: SessionOpts): Promise<ActiveSession> {
    if (!this.opts.findBinary()) {
      throw new Error("qoder is not installed on this server");
    }

    const existing = this.sessions.get(opts.conversationId);
    if (existing) {
      // LRU bump; spawn options are dead for a live session (the seam's rule),
      // so a reused session keeps the model it was born with until setModel.
      this.sessions.delete(opts.conversationId);
      this.sessions.set(opts.conversationId, existing);
      return existing.active;
    }

    this.evictForCapacity();

    const session = new QoderSession({
      cwd: opts.cwd,
      model: normalizeModel(opts.model),
      resumeSessionId: opts.resumeSessionId ?? null,
      runner: this.opts.runner,
      env: this.opts.credentials(),
      onSessionClosed: () => {
        // Only drop OUR entry: a newer session for the same conversation must
        // survive an old one's late close.
        if (this.sessions.get(opts.conversationId)?.session === session) {
          this.sessions.delete(opts.conversationId);
        }
        try {
          opts.onSessionClosed?.();
        } catch {
          // teardown must complete even if the hook misbehaves
        }
      },
    });

    const active: ActiveSession = {
      send: (text) => session.send(text),
      setModel: (model?: string) => session.setModel(normalizeModel(model ?? null) ?? undefined),
      interrupt: () => session.interrupt(),
      onEvent: (cb) => session.onEvent(cb),
      offEvent: (cb) => session.offEvent(cb),
      close: () => session.close(),
      cliSessionId: () => session.cliSessionId(),
    };

    // The SAME object is handed out on every lookup: callers compare identity
    // (bindings attach listeners once per session), so a fresh wrapper per
    // call would double-subscribe the transcript mirror.
    const entry: Entry = { session, active };
    this.sessions.set(opts.conversationId, entry);
    return active;
  }

  /** Stop-button path: peek without ever spawning anything. */
  liveSession(conversationId: string): ActiveSession | null {
    return this.sessions.get(conversationId)?.active ?? null;
  }

  size(): number {
    return this.sessions.size;
  }

  /** LRU across IDLE sessions only — an in-flight turn is never stolen. */
  private evictForCapacity(): void {
    while (this.sessions.size >= this.capacity) {
      let victim: string | null = null;
      for (const [id, entry] of this.sessions) {
        if (!entry.session.isRunning()) {
          victim = id;
          break;
        }
      }
      if (victim === null) {
        throw new Error(
          "qoder sessions at capacity: every session is mid-turn — stop one or raise MAX_CONCURRENT_TURNS",
        );
      }
      const evicted = this.sessions.get(victim);
      this.sessions.delete(victim);
      // Idle sessions hold no process, but they do hold listeners and a
      // pending onSessionClosed hook; closing tells their owner they are gone.
      void evicted?.session.close();
    }
  }
}

/**
 * Default detection: the same PATH probe the Integrations page uses, so the
 * chat route and the card can never disagree about what is installed.
 */
async function defaultDetect(): Promise<Detection> {
  const spec = integrationSpec("qoder");
  if (!spec) throw new Error("qoder integration spec is missing");
  return detectOne(spec);
}

/**
 * Per-server singleton. Construction does no I/O — detection and spawning
 * only happen on demand — so sharing one instance per process is cheap.
 */
let singleton: QoderAdapter | null = null;

export function getQoderAdapter(): QoderAdapter {
  if (!singleton) {
    const spec = integrationSpec("qoder");
    const bin = spec?.bin ?? "qoder";
    singleton = new QoderAdapter({
      runner: createQoderRunner(() => resolveOnPath(bin)),
      findBinary: () => resolveOnPath(bin),
      credentials: () => credentialEnvFor(getEnv().DATABASE_PATH, "qoder"),
    });
  }
  return singleton;
}

/** Test seam: drop the singleton so the next call rebuilds it. */
export function resetQoderAdapterForTest(): void {
  singleton = null;
}

import { describe, it, expect, vi } from "vitest";
import { ClaudeAdapter } from "../claude/adapter";
import type {
  ClaudeSessionPool,
  PoolGetOpts,
  PoolSession,
} from "../claude/session-pool";
import type { TurnEvent } from "../types";

/**
 * Adapter seam tests: the facade around the pool. The pool itself has its
 * own suite; what matters here is what the UI-facing contract (ActiveSession
 * + SessionOpts) promises — especially the model lifecycle:
 *   - fresh session:  model flows into spawn options ("auto" = no override)
 *   - reused session: model is APPLIED via setModel (spawn opts are dead on
 *     reuse — pool.get() ignores them), "auto" clears back to CLI default
 *   - no model:       the session is never touched (resume keeps its model)
 */

function makeFakeSession(): {
  session: PoolSession;
  setModelCalls: (string | undefined)[];
  closed: boolean;
} {
  const setModelCalls: (string | undefined)[] = [];
  const session: PoolSession = {
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    setModel: vi.fn(async (model?: string) => {
      setModelCalls.push(model);
    }),
    isRunning: () => false,
    cliSessionId: () => null,
    apiKeySource: () => null,
    cliVersion: () => null,
    onEvent: (_cb: (e: TurnEvent) => void) => {},
    offEvent: (_cb: (e: TurnEvent) => void) => {},
    close: vi.fn(async () => {}),
  };
  return { session, setModelCalls, closed: false };
}

function makeFakePool(opts: {
  live?: boolean;
}): {
  pool: ClaudeSessionPool;
  getCalls: PoolGetOpts[];
  session: PoolSession;
  makeLive: () => void;
} {
  const getCalls: PoolGetOpts[] = [];
  const current = makeFakeSession();
  const pool = {
    get: (_convId: string, getOpts: PoolGetOpts) => {
      getCalls.push(getOpts);
      return current.session;
    },
    getIfLive: (_convId: string) => (opts.live ? current.session : null),
    health: () => ({ active: 0, apiKeySource: null, cliVersion: null }),
    size: () => 0,
    closeAll: async () => {},
  };
  return {
    pool: pool as unknown as ClaudeSessionPool,
    getCalls,
    session: current.session,
    makeLive: () => {
      opts.live = true;
    },
  };
}

const BASE_OPTS = {
  conversationId: "u1:c1",
  cwd: "/tmp",
  model: null,
  resumeSessionId: null,
};

describe("claude adapter", () => {
  it("normalizes model='auto' to no override on a fresh session", async () => {
    const { pool, getCalls } = makeFakePool({ live: false });
    const adapter = new ClaudeAdapter(pool);
    await adapter.startsSession({ ...BASE_OPTS, model: "auto" });
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].model).toBeNull();
  });

  it("passes a concrete model through to spawn options", async () => {
    const { pool, getCalls } = makeFakePool({ live: false });
    const adapter = new ClaudeAdapter(pool);
    await adapter.startsSession({ ...BASE_OPTS, model: "opus" });
    expect(getCalls[0].model).toBe("opus");
  });

  it("applies an explicit model to a REUSED session via setModel", async () => {
    const { pool, session } = makeFakePool({ live: true });
    const adapter = new ClaudeAdapter(pool);
    await adapter.startsSession({ ...BASE_OPTS, model: "opus" });
    // pool.get opts are dead on reuse — setModel is what makes the model real
    expect(session.setModel).toHaveBeenCalledWith("opus");
    expect(session.setModel).toHaveBeenCalledTimes(1);
  });

  it("clears the override when a reused session gets model='auto'", async () => {
    const { pool, session } = makeFakePool({ live: true });
    const adapter = new ClaudeAdapter(pool);
    await adapter.startsSession({ ...BASE_OPTS, model: "auto" });
    expect(session.setModel).toHaveBeenCalledWith(undefined);
  });

  it("never touches the model when none is requested on reuse", async () => {
    const { pool, session } = makeFakePool({ live: true });
    const adapter = new ClaudeAdapter(pool);
    await adapter.startsSession({ ...BASE_OPTS, model: null });
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it("exposes setModel on the returned ActiveSession facade", async () => {
    const { pool, session } = makeFakePool({ live: true });
    const adapter = new ClaudeAdapter(pool);
    const s = await adapter.startsSession(BASE_OPTS);
    await s.setModel?.("sonnet");
    expect(session.setModel).toHaveBeenCalledWith("sonnet");
  });
});

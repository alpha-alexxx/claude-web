import type { UserRow } from "../db/users-repo";

/**
 * Authorization gate, deliberately a pure function.
 *
 * Next 16's docs are explicit that Proxy/middleware coverage can be lost by a
 * matcher change or a moved Server Function, so every route handler calls
 * this with the user it resolved locally. Keeping the decision pure means the
 * rules can be unit-tested without a request, a database or a network.
 */

export type Gate = "user" | "admin";

export type AuthFailureCode =
  | "unauthenticated"
  | "account_disabled"
  | "forbidden"
  | "no_email";

export interface AuthFailure {
  ok: false;
  status: 401 | 403;
  code: AuthFailureCode;
}

export type AuthDecision = { ok: true; user: UserRow } | AuthFailure;

export function authorize(user: UserRow | null, gate: Gate): AuthDecision {
  if (!user) return { ok: false, status: 401, code: "unauthenticated" };
  if (user.disabled) return { ok: false, status: 403, code: "account_disabled" };
  if (gate === "admin" && user.role !== "admin") {
    return { ok: false, status: 403, code: "forbidden" };
  }
  return { ok: true, user };
}

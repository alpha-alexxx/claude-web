import type { DatabaseSync } from "node:sqlite";

/**
 * The audit log: who did what, when, from where. One row per privileged
 * action (installs, uninstalls, integration changes). Detail is a small JSON
 * object of NON-SECRET facts — never a credential, never a full request body.
 *
 * Writes are best-effort at the call site (a failed audit must not turn a
 * completed install into an error the user retries), but the failure is
 * logged loudly by the caller.
 */

export interface AuditRow {
  id: number;
  userId: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export interface AuditInput {
  userId: string | null;
  action: string;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

export function recordAudit(db: DatabaseSync, input: AuditInput): void {
  const detail =
    input.detail === undefined
      ? null
      : JSON.stringify(input.detail, (_k, v) => {
          // Defence in depth: a caller that slips a credential into detail
          // still cannot persist it under an obviously secret-shaped key.
          if (typeof v === "string" && /^(sk-|pk_)/.test(v)) return "[redacted]";
          return v;
        });
  db.prepare(
    "INSERT INTO audit_log (user_id, action, detail_json, ip) VALUES (?, ?, ?, ?)",
  ).run(input.userId, input.action, detail, input.ip ?? null);
}

export function listAudit(db: DatabaseSync, limit = 100): AuditRow[] {
  const rows = db
    .prepare(
      `SELECT id, user_id, action, detail_json, ip, created_at
       FROM audit_log ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as {
    id: number;
    user_id: string | null;
    action: string;
    detail_json: string | null;
    ip: string | null;
    created_at: string;
  }[];
  return rows.map((r) => {
    let detail: Record<string, unknown> | null = null;
    if (r.detail_json) {
      try {
        const parsed: unknown = JSON.parse(r.detail_json);
        if (typeof parsed === "object" && parsed !== null) {
          detail = parsed as Record<string, unknown>;
        }
      } catch {
        // a corrupt row must not break the audit view
      }
    }
    return {
      id: r.id,
      userId: r.user_id,
      action: r.action,
      detail,
      ip: r.ip,
      createdAt: r.created_at,
    };
  });
}

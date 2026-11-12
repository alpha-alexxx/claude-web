import type { DatabaseSync } from "node:sqlite";
import type { ProviderId } from "@/lib/providers/types";

/**
 * Integration rows: the operator's INTENT per provider (enabled or not) plus
 * the last observed version/auth state. Deliberately contains no credential
 * material — credentials live in `data/integrations.env` (0600) and are read
 * only when spawning that provider's child process.
 *
 * A row is created on first write; absence means "not enabled, never checked",
 * which is the same thing to every reader.
 */

export interface IntegrationRow {
  provider: ProviderId;
  enabled: boolean;
  version: string | null;
  authed: boolean;
  lastCheckedAt: string | null;
}

interface RawRow {
  provider: ProviderId;
  enabled: number;
  version: string | null;
  authed: number;
  last_checked_at: string | null;
}

const SELECT = `SELECT provider, enabled, version, authed, last_checked_at FROM integrations`;

function toRow(raw: RawRow): IntegrationRow {
  return {
    provider: raw.provider,
    enabled: raw.enabled !== 0,
    version: raw.version,
    authed: raw.authed !== 0,
    lastCheckedAt: raw.last_checked_at,
  };
}

export function listIntegrations(db: DatabaseSync): IntegrationRow[] {
  const rows = db.prepare(`${SELECT} ORDER BY provider`).all() as unknown as RawRow[];
  return rows.map(toRow);
}

export function findIntegration(
  db: DatabaseSync,
  provider: ProviderId,
): IntegrationRow | null {
  // `node:sqlite` types rows as Record<string, SQLOutputValue>; the cast is the
  // same one every repo here makes, and the SELECT above is the contract.
  const raw = db.prepare(`${SELECT} WHERE provider = ?`).get(provider) as unknown as
    | RawRow
    | undefined;
  return raw ? toRow(raw) : null;
}

/** Upsert the enabled flag. Enabling is an explicit operator action. */
export function setIntegrationEnabled(
  db: DatabaseSync,
  provider: ProviderId,
  enabled: boolean,
): IntegrationRow {
  db.prepare(
    `INSERT INTO integrations (provider, enabled, last_checked_at)
     VALUES (?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled`,
  ).run(provider, enabled ? 1 : 0, new Date().toISOString());
  return findIntegration(db, provider)!;
}

/**
 * Record what a detection pass observed. Called with the values detection
 * just produced, never with a client-supplied body.
 *
 * `version: null` means "this caller did not learn a version" — the auth route
 * records a credential change, which says nothing about the binary. It must
 * therefore not erase a version a real detection pass already stored, so the
 * upsert keeps the existing value when the observation is null. Only a fresh
 * detection that parses a version can change it.
 */
export function recordIntegrationCheck(
  db: DatabaseSync,
  provider: ProviderId,
  observed: { version: string | null; authed: boolean },
): void {
  db.prepare(
    `INSERT INTO integrations (provider, enabled, version, authed, last_checked_at)
     VALUES (?, 0, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       version = COALESCE(excluded.version, integrations.version),
       authed = excluded.authed,
       last_checked_at = excluded.last_checked_at`,
  ).run(provider, observed.version, observed.authed ? 1 : 0, new Date().toISOString());
}

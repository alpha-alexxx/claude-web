import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate } from "../migrate";
import {
  findIntegration,
  listIntegrations,
  recordIntegrationCheck,
  setIntegrationEnabled,
} from "../integrations-repo";

/**
 * Integration rows are operator intent plus last observation — no credential
 * material may ever reach them. The properties worth pinning are the upsert
 * behaviour of both writers: `setIntegrationEnabled` must not wipe the
 * observed version, and `recordIntegrationCheck` must not switch a provider
 * off just because a detection pass ran.
 */

let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "integrations-repo-"));
  db = new DatabaseSync(path.join(dir, "test.db"));
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("integrations repo", () => {
  it("returns nothing for a provider that was never written", () => {
    expect(listIntegrations(db)).toEqual([]);
    expect(findIntegration(db, "codex")).toBeNull();
  });

  it("creates a row on first enable and reports it as enabled", () => {
    const row = setIntegrationEnabled(db, "codex", true);
    expect(row).toMatchObject({ provider: "codex", enabled: true, version: null });
    expect(row.lastCheckedAt).toBeTruthy();
    expect(findIntegration(db, "codex")).toMatchObject({ enabled: true });
  });

  it("keeps the observed version when toggling", () => {
    recordIntegrationCheck(db, "codex", { version: "0.167.0", authed: true });
    setIntegrationEnabled(db, "codex", true);
    expect(findIntegration(db, "codex")).toMatchObject({
      enabled: true,
      version: "0.167.0",
      authed: true,
    });
  });

  it("does not disable a provider when a later detection pass records a version", () => {
    setIntegrationEnabled(db, "codex", true);
    recordIntegrationCheck(db, "codex", { version: "0.167.1", authed: false });
    expect(findIntegration(db, "codex")).toMatchObject({
      enabled: true,
      version: "0.167.1",
      authed: false,
    });
  });

  it("keeps a stored version when a later check observes none", () => {
    // The auth route records a credential change and passes `version: null`:
    // it learned nothing about the binary, so it must not erase a version a
    // detection pass already stored (the card would lose its "0.167.0").
    recordIntegrationCheck(db, "codex", { version: "0.167.0", authed: false });
    recordIntegrationCheck(db, "codex", { version: null, authed: true });
    expect(findIntegration(db, "codex")).toMatchObject({
      version: "0.167.0",
      authed: true,
    });
  });

  it("lists rows in provider order", () => {
    setIntegrationEnabled(db, "qoder", true);
    setIntegrationEnabled(db, "codex", true);
    expect(listIntegrations(db).map((r) => r.provider)).toEqual(["codex", "qoder"]);
  });

  it("stores no credential-shaped column", () => {
    const columns = db
      .prepare("PRAGMA table_info(integrations)")
      .all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual([
      "provider",
      "enabled",
      "version",
      "authed",
      "last_checked_at",
    ]);
  });
});

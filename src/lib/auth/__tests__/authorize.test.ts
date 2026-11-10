import { describe, it, expect } from "vitest";
import { authorize, type AuthFailure } from "../authorize";
import type { UserRow } from "../../db/users-repo";

const base: UserRow = {
  id: "user_1",
  email: "a@example.com",
  displayName: "A",
  role: "user",
  disabled: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("authorize", () => {
  it("rejects a missing identity with 401", () => {
    const r = authorize(null, "user");
    expect(r.ok).toBe(false);
    expect((r as AuthFailure).status).toBe(401);
    expect((r as AuthFailure).code).toBe("unauthenticated");
  });

  it("rejects a disabled account with 403 even if the role would pass", () => {
    const r = authorize({ ...base, role: "admin", disabled: true }, "admin");
    expect(r.ok).toBe(false);
    expect((r as AuthFailure).status).toBe(403);
    expect((r as AuthFailure).code).toBe("account_disabled");
  });

  it("admits an enabled user for the user gate", () => {
    expect(authorize(base, "user")).toMatchObject({ ok: true });
  });

  it("rejects a non-admin at the admin gate with 403 forbidden", () => {
    const r = authorize(base, "admin");
    expect(r.ok).toBe(false);
    expect((r as AuthFailure).status).toBe(403);
    expect((r as AuthFailure).code).toBe("forbidden");
  });

  it("admits an enabled admin", () => {
    expect(authorize({ ...base, role: "admin" }, "admin")).toMatchObject({
      ok: true,
    });
  });
});

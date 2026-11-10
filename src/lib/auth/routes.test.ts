import { describe, it, expect } from "vitest";
import { isProtectedPage, SIGN_IN_URL, SIGN_UP_URL } from "./routes";

describe("isProtectedPage", () => {
  it("protects the four app surfaces and their subpaths", () => {
    for (const p of [
      "/chat",
      "/chat/abc",
      "/skills",
      "/plugins/x",
      "/settings/users",
    ]) {
      expect(isProtectedPage(p), p).toBe(true);
    }
  });

  it("leaves the public landing page, sign-in and sign-up open", () => {
    for (const p of ["/", "/sign-in", "/sign-in/factor-one", "/sign-up"]) {
      expect(isProtectedPage(p), p).toBe(false);
    }
  });

  it("never matches API routes — those enforce auth in the handler", () => {
    // Clerk's protect() answers 404 for non-document requests; our handlers
    // answer 401 with a JSON body instead.
    expect(isProtectedPage("/api/chat")).toBe(false);
    expect(isProtectedPage("/api/health")).toBe(false);
  });

  it("does not treat a prefix collision as protected", () => {
    expect(isProtectedPage("/chatter")).toBe(false);
    expect(isProtectedPage("/settings2")).toBe(false);
  });

  it("exposes stable local auth paths", () => {
    expect(SIGN_IN_URL).toBe("/sign-in");
    expect(SIGN_UP_URL).toBe("/sign-up");
  });
});

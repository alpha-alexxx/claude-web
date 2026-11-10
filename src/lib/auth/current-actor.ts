import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getDb } from "../db/client";
import { ensureUser, type UserRow } from "../db/users-repo";
import { authorize, type AuthDecision } from "./authorize";

/**
 * Turns a Clerk session into a local authorization decision.
 *
 * Flow: Clerk's `auth()` answers "is there a session at all" (cheap, from the
 * verified session token). Only then do we hit `currentUser()` and the local
 * `users` mirror, which is the source of truth for role + disabled. This
 * keeps the expensive path off unauthenticated requests.
 *
 * The user row is refreshed from Clerk on the way through (see ensureUser),
 * so role changes made in the local admin UI and profile changes made in
 * Clerk both take effect on the next request.
 *
 * IMPORTANT (Next 16 docs, "Data Security"): Proxy coverage can be silently
 * lost by a matcher change, so authentication is enforced HERE, in every
 * route handler and server component — Proxy only does the cheap redirect.
 */
export async function currentActor(): Promise<UserRow | null> {
  const { userId } = await auth();
  if (!userId) return null;

  const user = await currentUser();
  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress;
  if (!email) return null; // no usable identity without an email address

  const db = getDb();
  return ensureUser(db, {
    id: userId,
    email,
    displayName: user?.fullName ?? user?.username ?? null,
  });
}

/**
 * Route-handler gate: resolves the actor and applies the authorization gate.
 * Returns the decision verbatim — the caller renders the 401/403.
 */
export async function requireActor(gate: "user" | "admin"): Promise<AuthDecision> {
  return authorize(await currentActor(), gate);
}

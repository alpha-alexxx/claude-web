/**
 * Form → request body for the credential card.
 *
 * Two rules, both security-relevant:
 *   1. Only keys the provider DECLARES are read from the form. A stray input
 *      (an autofilled browser field, a pasted extra name) can never travel to
 *      the auth route, which would otherwise have to be the only guard against
 *      an undeclared secret being written.
 *   2. Empty values are dropped rather than sent as "". Submitting a form with
 *      one field filled must not erase the other stored key, and the route
 *      treats `values: {}` as a no-op by contract.
 *
 * Values are trimmed of surrounding whitespace only — an interior space is
 * part of a token as far as we know, and mangling it would be a silent
 * authentication failure.
 */

export function credentialValues(
  declaredKeys: readonly string[],
  read: (key: string) => unknown,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of declaredKeys) {
    const raw = read(key);
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value) values[key] = value;
  }
  return values;
}

/** True when there is something to submit — the Save button's enable rule. */
export function hasCredentialInput(
  declaredKeys: readonly string[],
  read: (key: string) => unknown,
): boolean {
  return Object.keys(credentialValues(declaredKeys, read)).length > 0;
}

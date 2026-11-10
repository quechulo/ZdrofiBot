/**
 * Symfony re-masks a CSRF token on every render as "<noise>.<key>.<masked>", so
 * two renders look different while the token underneath stays the same. Tokens
 * are per session and per form, not per class: one fetched from any open class
 * works on another, which is what lets a registration fire without a page load.
 */
export function tokenCore(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const key = Buffer.from(parts[1] ?? "", "base64url");
  const masked = Buffer.from(parts[2] ?? "", "base64url");
  if (key.length === 0 || masked.length === 0) return null;
  const core = masked.map((byte, index) => byte ^ (key[index % key.length] ?? 0));
  return Buffer.from(core).toString("utf8");
}

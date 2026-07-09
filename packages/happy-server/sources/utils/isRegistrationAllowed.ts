/**
 * Decides whether an account may be created for a given public key.
 *
 * The allowlist is supplied as a comma-separated list of public-key hex strings
 * (env var HAPPY_ALLOWED_PUBLIC_KEYS). When the allowlist is empty or unset,
 * registration is open — this is required for first-boot bootstrap, after which
 * the operator fills the allowlist and redeploys to lock registration down.
 */
export function isRegistrationAllowed(publicKeyHex: string, allowlistEnv: string | undefined): boolean {
    const allow = (allowlistEnv || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    if (allow.length === 0) {
        return true;
    }
    return allow.includes(publicKeyHex.toLowerCase());
}

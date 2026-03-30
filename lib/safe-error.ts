/**
 * Sanitizes an error message for client-facing responses.
 *
 * Why: raw error messages may contain connection strings, API keys, or internal
 * paths. This strips known secret patterns and truncates to a safe length.
 * The result is safe to return in JSON responses while still being useful
 * for debugging (e.g., "connect ECONNREFUSED", "Not Found", "timeout").
 */
export function safeErrorMessage(err: unknown, prefix: string): string {
  const msg = (err instanceof Error ? err.message : String(err)) ?? 'unknown error'
  const sanitized = msg
    .replace(/postgresql:\/\/[^\s]+/gi, '[REDACTED_URL]')
    .replace(/postgres:\/\/[^\s]+/gi, '[REDACTED_URL]')
    .replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED_KEY]')
    .replace(/vck_[a-zA-Z0-9_-]+/g, '[REDACTED_KEY]')
    .slice(0, 200)
  return `${prefix}: ${sanitized}`
}

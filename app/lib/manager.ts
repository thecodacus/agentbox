/**
 * Shared client for the manager API.
 *
 * The manager holds the Docker socket, so reaching it means controlling every
 * container on the host. When MANAGER_TOKEN is configured every request carries
 * it — keep all manager traffic going through here so no call site can forget.
 *
 * Server-side only: MANAGER_TOKEN must never be exposed to the browser, so this
 * module must not be imported from a client component.
 */
export const MANAGER_URL = process.env.MANAGER_URL || "http://localhost:4000";

const MANAGER_TOKEN = process.env.MANAGER_TOKEN || "";

/** Auth headers for the manager API; empty when running unauthenticated. */
export function managerHeaders(
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    ...(MANAGER_TOKEN ? { Authorization: `Bearer ${MANAGER_TOKEN}` } : {}),
    ...extra,
  };
}

/** fetch() against the manager with auth applied. */
export function managerFetch(path: string, options: RequestInit = {}) {
  return fetch(`${MANAGER_URL}${path}`, {
    ...options,
    headers: managerHeaders(options.headers as Record<string, string> | undefined),
  });
}

/**
 * The browser's path to this app's own routes — the `/api/kantor/*` handlers, which compose other
 * domains' reads on the server.
 *
 * Deliberately **not** `kasirFetch`: that prefixes `/api/bff/core`, which proxies to `apps/api`. The
 * dashboard is composed in the web app, so it lives at `/api/kantor/dashboard` and is fetched
 * directly. Same session cookie, same `credentials: 'same-origin'`, and the access token still never
 * reaches the browser — it is attached inside the route handler.
 */
export async function kantorFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new KantorRequestFailed(response.status);
  return (await response.json()) as T;
}

/** A refusal from the web app's own route, with its status for the screen that has to explain it. */
export class KantorRequestFailed extends Error {
  constructor(readonly status: number) {
    super('Permintaan dasbor gagal.');
  }
}

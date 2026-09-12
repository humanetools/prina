/** fetch wrapper — session cookie + workspace header. Distinguishes errors by status code */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
  }
}

/**
 * Readable text for a failed request. The command pipeline puts the per-field zod messages in
 * details.issues and leaves message as a generic "<command>: input is not valid", so preferring
 * issues is the difference between "why" and "something is wrong".
 */
export function apiErrorMessage(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  const issues = (e.details as { issues?: string[] } | null)?.issues;
  return issues?.length ? issues.join(" · ") : e.message;
}

const WORKSPACE_KEY = "prina.workspace";

export function getWorkspaceSlug(): string {
  return localStorage.getItem(WORKSPACE_KEY) ?? "default";
}

export function setWorkspaceSlug(slug: string): void {
  localStorage.setItem(WORKSPACE_KEY, slug);
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      "x-prina-workspace": getWorkspaceSlug(),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(
      res.status,
      err.code ?? "UNKNOWN",
      err.message ?? `Request failed (${res.status})`,
      err.details ?? null,
    );
  }
  return data as T;
}

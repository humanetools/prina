/**
 * OpenAPI operation declarations (21-IMPL-openapi-completion).
 *
 * One declaration per token-reachable route. The request shape is not rewritten here: `input`
 * is the zod schema of the command the route runs, and the builder converts it. What a token
 * needs for the operation is not written here either — the builder asks api-grants / api-scopes.
 */
import type { ZodTypeAny } from "zod";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface QueryParam {
  name: string;
  description: string;
  schema?: Record<string, unknown>;
}

export interface OpDecl {
  method: HttpMethod;
  /** Fastify route url, exactly as registered (`/api/content/:typeUid/:id`) */
  path: string;
  summary: string;
  description?: string;
  tag: string;
  /** Command input schema. Path params are removed; the rest is the JSON body (or the query on GET) */
  input?: ZodTypeAny;
  /** Body properties documented by a shared schema instead of the (opaque) zod type: key → components.schemas name */
  bodyRefs?: Record<string, string>;
  /** Body keys the command requires although their zod type (`unknown`) cannot say so */
  require?: string[];
  /** Input keys the route does not take from the client (beyond path params) */
  omit?: string[];
  /** Query parameters the route reads itself (not part of `input`) */
  query?: QueryParam[];
  /** Non-JSON request body, e.g. the raw file of a local upload */
  rawBody?: { contentType: string; description: string };
  /** Success status (default 200) */
  status?: 200 | 201;
  /** What comes back — prose; commands do not declare output schemas */
  returns: string;
  /** Extra non-2xx responses by status → components.responses key */
  errors?: Record<string, string>;
  /** Also emitted once per content type with the type's `values` schema inlined */
  perType?: boolean;
}

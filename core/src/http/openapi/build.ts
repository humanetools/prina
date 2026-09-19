/**
 * Declarations → OpenAPI operations (21-IMPL-openapi-completion).
 *
 * Access requirements come from the same functions the auth hook calls (api-grants / api-scopes),
 * request shapes from the command input schemas — nothing about either is restated here.
 */
import type { ZodTypeAny } from "zod";
import { API_GRANT_AREA_OF, API_GRANT_TYPED } from "@prina/shared";
import { requiredGrantFor } from "../api-grants.js";
import { requiredScopeFor } from "../api-scopes.js";
import { ERROR_RESPONSE_REFS } from "./errors.js";
import { toJsonSchema } from "./json-schema.js";
import { SCHEMA_OPS } from "./decl-schema.js";
import { CONTENT_OPS } from "./decl-content.js";
import type { OpDecl } from "./types.js";

export const API_OPS: OpDecl[] = [...SCHEMA_OPS, ...CONTENT_OPS];

type Json = Record<string, unknown>;

const TOKEN_SECURITY = [{ session: [] }, { managementToken: [] }];
const paramNames = (path: string) => [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);

/** `/api/x/:id` → `/api/x/{id}`; with `bind`, that param becomes a literal segment */
export function openApiPath(path: string, bind?: Record<string, string>): string {
  return path.replace(/:([A-Za-z]+)/g, (_m, name: string) => bind?.[name] ?? `{${name}}`);
}

/** What a token needs for this operation — the hook's own answer, for a representative url */
export function accessOf(method: string, path: string): Json {
  const url = path.replace(/:[A-Za-z]+/g, "x");
  const grant = requiredGrantFor(method, url);
  const scope = requiredScopeFor(method, url);
  return {
    grant: grant
      ? { area: API_GRANT_AREA_OF[grant.item], item: grant.item, level: grant.level, typed: API_GRANT_TYPED.includes(grant.item) }
      : null,
    scope: scope ? { resource: scope.scope, level: scope.level } : null,
  };
}

function objectSchema(input: ZodTypeAny): { properties: Record<string, Json>; required: string[] } {
  const js = toJsonSchema(input);
  return {
    properties: (js.properties as Record<string, Json> | undefined) ?? {},
    required: (js.required as string[] | undefined) ?? [],
  };
}

function buildOperation(decl: OpDecl, bind: Record<string, string> | undefined, valuesRef: Json | undefined): Json {
  const pathParams = paramNames(decl.path);
  const dropped = new Set([...pathParams, ...(decl.omit ?? [])]);
  const parameters: Json[] = pathParams
    .filter((name) => !bind?.[name])
    .map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));

  const operationId = `${decl.method.toLowerCase()}_${openApiPath(decl.path, bind).replace(/^\/api\//, "").replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+/g, "_")}`;
  const op: Json = { operationId, summary: decl.summary, tags: [decl.tag], security: TOKEN_SECURITY, "x-prina-access": accessOf(decl.method, decl.path) };
  if (decl.description) op.description = decl.description;

  if (decl.input) {
    const { properties, required } = objectSchema(decl.input);
    const kept = Object.entries(properties).filter(([key]) => !dropped.has(key));
    if (decl.method === "GET") {
      for (const [name, schema] of kept) {
        const { description, ...rest } = schema as { description?: string };
        parameters.push({ name, in: "query", required: required.includes(name), ...(description ? { description } : {}), schema: rest });
      }
    } else if (kept.length) {
      const props = Object.fromEntries(
        kept.map(([key, schema]) => {
          if (key === "values" && valuesRef) return [key, valuesRef];
          const shared = decl.bodyRefs?.[key];
          return [key, shared ? { $ref: `#/components/schemas/${shared}` } : schema];
        }),
      );
      const req = [...new Set([...required, ...(decl.require ?? [])])].filter((key) => !dropped.has(key));
      op.requestBody = {
        required: req.length > 0,
        content: { "application/json": { schema: { type: "object", properties: props, ...(req.length ? { required: req } : {}) } } },
      };
    }
  }
  if (decl.rawBody) {
    op.requestBody = {
      required: true,
      description: decl.rawBody.description,
      content: { [decl.rawBody.contentType]: { schema: { type: "string", format: "binary" } } },
    };
  }
  for (const p of decl.query ?? []) {
    parameters.push({ name: p.name, in: "query", description: p.description, schema: p.schema ?? { type: "string" } });
  }
  if (parameters.length) op.parameters = parameters;

  const responses: Json = { [String(decl.status ?? 200)]: { description: decl.returns } };
  for (const [status, ref] of Object.entries({ ...ERROR_RESPONSE_REFS, ...(decl.errors ?? {}) })) {
    responses[status] = { $ref: `#/components/responses/${ref}` };
  }
  op.responses = responses;
  return op;
}

export interface TypeForSpec { uid: string; name: string; valuesRef: Json }

/**
 * Paths for every declared operation whose route is actually registered (edition- and
 * adapter-dependent routes drop out by themselves). Content routes appear twice: generic
 * (`{typeUid}`) and, for the core CRUD + transition, once per type with its values schema.
 */
export function buildApiPaths(routeTable: ReadonlyArray<{ method: string; url: string }>, types: TypeForSpec[]): Record<string, Json> {
  const registered = new Set(routeTable.map((r) => `${r.method.toUpperCase()} ${r.url}`));
  const paths: Record<string, Json> = {};
  const put = (path: string, method: string, op: Json) => {
    (paths[path] ??= {})[method.toLowerCase()] = op;
  };
  for (const decl of API_OPS) {
    if (!registered.has(`${decl.method} ${decl.path}`)) continue;
    put(openApiPath(decl.path), decl.method, buildOperation(decl, undefined, undefined));
    if (!decl.perType) continue;
    for (const type of types) {
      const bind = { typeUid: type.uid };
      const op = buildOperation(decl, bind, type.valuesRef);
      op.summary = `${decl.summary} — ${type.name}`;
      put(openApiPath(decl.path, bind), decl.method, op);
    }
  }
  return paths;
}

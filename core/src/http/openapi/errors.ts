/** Shared error responses — every `/api/*` error has the same envelope: { error: { code, message, details } } */

const envelope = (codes: string[], details: Record<string, unknown> = {}) => ({
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string", enum: codes },
        message: { type: "string", description: "Human-readable; safe to show or to feed back to an agent" },
        details: { type: ["object", "null"], ...details },
      },
    },
  },
});

const json = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: { "application/json": { schema } },
});

export const ERROR_RESPONSES = {
  Unauthorized: json("No valid session or access token (missing, malformed, revoked or expired)", envelope(["UNAUTHORIZED"])),
  Forbidden: json(
    "`SCOPE_DENIED` — the token was not issued for this operation (compare `x-prina-access` with `error.details`: " +
      "{ item | scope, required, granted, typeUid? }); issue a token with the missing grant. " +
      "`FORBIDDEN` — the token reaches the operation but its permissions (role, or the issuer's ceiling) do not allow it.",
    envelope(["SCOPE_DENIED", "FORBIDDEN"], {
      properties: {
        item: { type: ["string", "null"], description: "Custom-grant tokens: the grant item this operation needs" },
        scope: { type: ["string", "null"], description: "Role tokens: the resource scope this operation needs" },
        required: { type: "string", enum: ["read", "edit"] },
        typeUid: { type: ["string", "null"] },
        granted: { description: "What the token holds for that item / scope, or null" },
      },
    }),
  ),
  NotFound: json("The resource (or the content type in the path) does not exist in the token's workspace", envelope(["NOT_FOUND"])),
  Conflict: json("The request conflicts with current state — duplicate uid / code, resource still in use", envelope(["CONFLICT"])),
  Validation: json(
    "The input is not valid. `error.details.issues[]` lists `path: message` per problem; field-level value errors and workflow refusals arrive here too.",
    envelope(["VALIDATION_ERROR"], { properties: { issues: { type: "array", items: { type: "string" } } } }),
  ),
  AiNotConfigured: json("`AI_NOT_CONFIGURED` — the workspace has no AI provider key (Settings › AI, BYOK)", envelope(["AI_NOT_CONFIGURED"])),
  AiProvider: json("`AI_PROVIDER_ERROR` — the AI provider failed or timed out; nothing was created, the call can be retried", envelope(["AI_PROVIDER_ERROR"])),
};

/** status → components.responses key, attached to every token-reachable operation */
export const ERROR_RESPONSE_REFS: Record<string, keyof typeof ERROR_RESPONSES> = {
  "401": "Unauthorized",
  "403": "Forbidden",
  "404": "NotFound",
  "409": "Conflict",
  "422": "Validation",
};

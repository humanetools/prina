/** Fastify app assembly (T0.2) — API + Admin static serving in one process */
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { EventEmitter } from "node:events";
import { ZodError } from "zod";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Env } from "./env.js";
import type { Db } from "./db/client.js";
import { CORE_VERSION } from "./version.js";
import { allowAllTransitionGuard, type Services } from "./commands/context.js";
import type { EeModule } from "./ee-loader.js";
import { createFieldTypeRegistry } from "./content/field-types/index.js";
import { SchemaCache } from "./content/schema-compiler.js";
import { AppError } from "./lib/errors.js";
import { rbacAuthorize } from "./modules/rbac/service.js";
import { createStorageServices, type StorageServices } from "./storage/index.js";
import { registerAssetRoutes } from "./http/routes/assets.js";
import { registerImgRoutes } from "./http/routes/img.js";
import { registerTemplateRoutes } from "./http/routes/templates.js";
import { registerDeliveryRoutes } from "./http/routes/delivery.js";
import { registerMcpRoutes } from "./http/routes/mcp.js";
import { registerMcpConsoleRoutes } from "./http/routes/mcp-console.js";
import { registerOAuthRoutes } from "./http/routes/oauth.js";
import { registerImportAiRoutes } from "./http/routes/import-ai.js";
import { registerAuthHooks } from "./http/auth-hooks.js";
import { registerHealthRoutes } from "./http/routes/health.js";
import { registerAuthRoutes } from "./http/routes/auth.js";
import { registerSetupRoutes } from "./http/routes/setup.js";
import { registerContentTypeRoutes } from "./http/routes/content-types.js";
import { registerEntryRoutes } from "./http/routes/entries.js";
import { registerSettingsRoutes } from "./http/routes/settings.js";
import { registerTaxonomyRoutes } from "./http/routes/taxonomy.js";
import { registerOpenApiRoutes } from "./http/routes/openapi.js";
import { registerTunnelRoutes, type TunnelRouteDeps } from "./http/routes/tunnel.js";
import { registerRootRoute } from "./http/routes/root.js";

export { CORE_VERSION } from "./version.js";

export function createServices(storage: StorageServices, ee?: EeModule | null): Services {
  const registry = createFieldTypeRegistry();
  return {
    registry,
    schemas: new SchemaCache(registry),
    // T2.2 RBAC enforcement engine is core (default roles — IMPL-ee-boundary §0.1)
    authorize: rbacAuthorize,
    // T2.3 transition guard is an EE product surface — OSS only checks transition definitions (allowAll)
    transitionGuard: ee?.transitionGuard ?? allowAllTransitionGuard,
    assistantTools: ee?.assistantTools?.() ?? [],
    // Entry lifecycle fan-out (10-IMPL-chatbot C0) — undefined in OSS: emitEntryEvent no-ops
    onEntryEvent: ee?.onEntryEvent,
    storage,
    events: new EventEmitter(),
  };
}

export type AppEnv = Pick<
  Env,
  | "LOG_LEVEL" | "ADMIN_DIST_PATH" | "NODE_ENV"
  | "S3_ENDPOINT" | "S3_BUCKET" | "S3_ACCESS_KEY" | "S3_SECRET_KEY" | "S3_REGION"
  | "IMGPROXY_URL" | "IMGPROXY_KEY" | "IMGPROXY_SALT" | "LOCAL_STORAGE_DIR"
  | "BRAND_NAME" | "BRAND_LOGO_URL" | "BRAND_THEME"
> &
  // Optional here so existing callers (tests) keep the proxy-less default
  Partial<Pick<Env, "TRUST_PROXY" | "IMGPROXY_PUBLIC_URL" | "ONE_TIME_LOGIN_PUBLIC_KEY">>;

export interface BuildAppOptions {
  env: AppEnv;
  db: Db;
  services?: Services;
  /** EE module (IMPL-ee-boundary) — behaves as OSS when not injected */
  ee?: EeModule | null;
  /** Public tunnel (IMPL-public-tunnel) — routes are absent when not injected (tests) */
  tunnel?: TunnelRouteDeps;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const services = opts.services ?? createServices(createStorageServices(opts.env), opts.ee);
  const app = Fastify({
    // Optional (default false): proxy headers are only honored when the operator says so
    trustProxy: opts.env.TRUST_PROXY === "true",
    logger: {
      level: opts.env.LOG_LEVEL,
      ...(opts.env.NODE_ENV === "development"
        ? {}
        : { formatters: { level: (label) => ({ level: label }) } }),
    },
  });

  // Receive non-JSON bodies (e.g. file upload via local adapter PUT) as buffers
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(422).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Input is not valid",
          details: {
            issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          },
        },
      });
    }
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message, details: err.details ?? null },
      });
    }
    // Pass Fastify's own 4xx (empty JSON body, etc.) through instead of masking as 500
    const fastifyErr = err as { statusCode?: number; code?: string; message?: string };
    if (typeof fastifyErr.statusCode === "number" && fastifyErr.statusCode < 500) {
      return reply.status(fastifyErr.statusCode).send({
        error: {
          code: fastifyErr.code ?? "BAD_REQUEST",
          message: fastifyErr.message ?? "Bad request",
          details: null,
        },
      });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({
      error: { code: "INTERNAL", message: "An internal error occurred", details: null },
    });
  });

  // Setup gate + session auth (T2.1) — runs before all routes
  registerAuthHooks(app, {
    db: opts.db,
    isProduction: opts.env.NODE_ENV === "production",
  });

  registerHealthRoutes(app, opts.db, CORE_VERSION);
  registerSetupRoutes(app, opts.db);
  registerAuthRoutes(app, opts.db, services, {
    oneTimeLoginPublicKey: opts.env.ONE_TIME_LOGIN_PUBLIC_KEY,
  });
  registerContentTypeRoutes(app, opts.db, services);
  registerEntryRoutes(app, opts.db, services);
  registerSettingsRoutes(app, opts.db, services);
  registerTaxonomyRoutes(app, opts.db, services);
  registerAssetRoutes(app, opts.db, services);
  // Rendition proxy — only when a signer exists, i.e. imgproxy is configured
  if (services.storage.imgproxy && opts.env.IMGPROXY_URL) {
    registerImgRoutes(app, opts.env.IMGPROXY_URL);
  }
  registerTemplateRoutes(app, opts.db, services);
  registerDeliveryRoutes(app, opts.db, services);
  registerMcpRoutes(app, opts.db, services);
  registerMcpConsoleRoutes(app, opts.db, services);
  registerOAuthRoutes(app, opts.db);
  registerImportAiRoutes(app, opts.db, services);
  registerOpenApiRoutes(app, opts.db, services, CORE_VERSION);
  if (opts.tunnel) registerTunnelRoutes(app, opts.db, opts.tunnel);
  // Browser landing for the instance address — the provisioning email links here
  registerRootRoute(app, opts.db, opts.tunnel?.localPort ?? 3000);

  // EE route/command registration (IMPL-ee-boundary) — after core routes, before static serving
  opts.ee?.register?.({ app, db: opts.db, services, env: opts.env });

  // Admin static serving (T0.5 DoD: API+Admin from a single core) — includes SPA fallback
  const adminDist = opts.env.ADMIN_DIST_PATH
    ? path.resolve(opts.env.ADMIN_DIST_PATH)
    : path.resolve(process.cwd(), "admin-dist");
  if (existsSync(adminDist)) {
    // Whitelabel (T8.5) is EE — serve the original index.html when not injected
    const transform = opts.ee?.transformIndexHtml ?? ((html: string) => html);
    const indexPath = path.join(adminDist, "index.html");
    const indexHtml = existsSync(indexPath)
      ? transform(readFileSync(indexPath, "utf8"), opts.env)
      : null;
    const sendIndex = (reply: FastifyReply) =>
      indexHtml !== null
        ? reply.type("text/html; charset=utf-8").send(indexHtml)
        : reply.sendFile("index.html", adminDist);

    app.register(fastifyStatic, { root: adminDist, prefix: "/admin/", index: false });
    app.get("/admin", (_req, reply) => reply.redirect("/admin/"));
    app.get("/admin/", (_req, reply) => sendIndex(reply));
    app.get("/admin/index.html", (_req, reply) => sendIndex(reply));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/admin/") && req.method === "GET") {
        return sendIndex(reply);
      }
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Route not found", details: null },
      });
    });
    app.log.info(
      { adminDist, whitelabel: opts.ee?.transformIndexHtml !== undefined },
      "Serving Admin UI statically",
    );
  }

  return app;
}

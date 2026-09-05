import { z } from "zod";

/**
 * Environment variable schema — validated at startup; missing vars die fast with a clear error (T0.2).
 * Sensitive values must only be injected via environment variables.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /**
   * Trust X-Forwarded-* from the immediate upstream (reverse proxy, fly.io, CDN).
   * "true" makes req.ip / req.protocol follow the proxy headers — needed for the login
   * throttle key and the Secure cookie flag behind TLS termination. Leave "false" on a
   * directly exposed host: clients could spoof X-Forwarded-For and dodge the throttle.
   */
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),

  /** e.g. postgres://user:pass@host:5432/prina */
  DATABASE_URL: z.string().url({ message: "DATABASE_URL is required (postgres://...)" }),

  /** Admin build output path — statically served at /admin when present */
  ADMIN_DIST_PATH: z.string().optional(),

  /** S3-compatible storage (becomes required in Phase 4) */
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),

  /** imgproxy sidecar (Phase 4) — internal address the core proxies to (never sent to browsers) */
  IMGPROXY_URL: z.string().optional(),
  IMGPROXY_KEY: z.string().optional(),
  IMGPROXY_SALT: z.string().optional(),
  /**
   * Public base of rendition URLs (IMPL-saas-cloud §3 ⑥). Signed rendition paths are
   * served through the core's `GET /img/*` proxy, so the default is the path-only `/img`
   * (same-origin, works behind any host). Set an absolute value — e.g.
   * `https://acme.example.com/img` — when renditions must be absolute (API consumers on
   * another origin). Optional; "" is treated as unset.
   */
  IMGPROXY_PUBLIC_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().optional(),
  ),

  /** Local storage fallback directory when S3 is not configured (dev/demo only) */
  LOCAL_STORAGE_DIR: z.string().optional(),

  /** Whitelabel (T8.5) — all optional: default Prina branding when unset.
   *  compose passes unset vars as empty strings, so "" is treated as unset. */
  BRAND_NAME: z.string().optional(),
  BRAND_LOGO_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),
  /** Theme token override JSON — e.g. {"light":{"--accent":"#2563eb"},"dark":{"--accent":"#60a5fa"}} */
  BRAND_THEME: z.string().optional(),

  /** License (T8.2) — all optional: when unset, only surfaced as unlicensed (no blocking) */
  LICENSE_KEY: z.string().optional(),
  /** Unset = air-gapped mode (offline signature verification only, no reporting) */
  LICENSE_SERVER_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().optional(),
  ),
  /** Grace period in days when license server is unreachable (§3: no immediate blocking) */
  LICENSE_GRACE_DAYS: z.coerce.number().int().positive().default(14),

  /** Public tunnel (IMPL-public-tunnel) — provisioning service; empty = feature surfaced as unavailable */
  TUNNEL_SERVICE_URL: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().url().default("https://prina-license.fly.dev"),
  ),
  /** cloudflared binary path or name on PATH (bundled in the Docker image) */
  TUNNEL_CLOUDFLARED_BIN: z.string().default("cloudflared"),

  /**
   * One-time admin login (IMPL-saas-cloud §3 ④) — Ed25519 public key (SPKI PEM) of the
   * Prina Cloud control plane's ONE_TIME_LOGIN_SIGNING_KEY (a separate key from the
   * license key). When set, `GET|POST /api/auth/one-time` exchanges a signed short-lived
   * token for an admin session. Optional; unset/"" leaves the route absent (404) —
   * on-prem installs never need it.
   */
  ONE_TIME_LOGIN_PUBLIC_KEY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().optional(),
  ),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // Cannot start — logger not initialized yet, so write to stderr directly
    console.error(`[prina-core] Environment validation failed:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

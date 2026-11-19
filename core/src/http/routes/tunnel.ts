/**
 * Public tunnel REST adapter (IMPL-public-tunnel) — relays the admin UI to the
 * Prina tunnel service (prina-license) and owns the issued state locally.
 *
 * The browser never talks to the tunnel service directly: no CORS surface, the
 * cloudflared connector token never passes through the browser, and core stays the
 * single owner of the issued state (auto-reconnect on restart).
 *
 * Sits behind the standard /api auth hooks — admin session required.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import {
  readTunnelState,
  writeTunnelState,
  type TunnelRuntime,
} from "../../modules/tunnel/service.js";

export interface TunnelRouteDeps {
  runtime: TunnelRuntime;
  /** Tunnel service base URL (the license server) */
  serviceUrl: string;
  /** Port core listens on inside the user's machine/container — cloudflared targets it */
  localPort: number;
  fetchImpl?: typeof fetch;
}

const codeBody = z.object({ email: z.string().trim().toLowerCase().email(), consent: z.literal(true) });
const verifyBody = z.object({ email: z.string().trim().toLowerCase().email(), code: z.string().regex(/^\d{3}$/) });
const createBody = z.object({ email: z.string().trim().toLowerCase().email(), subdomain: z.string().trim().toLowerCase() });

const TICKET_TTL_MS = 15 * 60 * 1000;

export function registerTunnelRoutes(app: FastifyInstance, db: Db, deps: TunnelRouteDeps): void {
  const doFetch = deps.fetchImpl ?? fetch;
  // Verify tickets live only minutes between /verify and /create — process memory is enough,
  // and keeping them out of the DB means nothing to clean up
  const tickets = new Map<string, { ticket: string; expiresAt: number }>();

  /** Relay to the tunnel service; service errors pass through so the UI can show the reason (§9) */
  const relay = async (
    path: string,
    body: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> | null } | null> => {
    try {
      const res = await doFetch(new URL(path, deps.serviceUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      return { status: res.status, json };
    } catch {
      return null; // network failure — mapped to 502 by callers
    }
  };

  const unreachable = {
    error: {
      code: "TUNNEL_SERVICE_UNREACHABLE",
      message: "Could not reach the Prina tunnel service — check your network and try again",
      details: null,
    },
  };

  app.post("/api/tunnel/code", async (req, reply) => {
    const input = codeBody.parse(req.body);
    const r = await relay("/v1/tunnels/code", { email: input.email, consent: true });
    if (!r) return reply.status(502).send(unreachable);
    return reply.status(r.status).send(r.json);
  });

  app.post("/api/tunnel/verify", async (req, reply) => {
    const input = verifyBody.parse(req.body);
    const r = await relay("/v1/tunnels/verify", input);
    if (!r) return reply.status(502).send(unreachable);
    if (r.status === 200 && typeof r.json?.ticket === "string") {
      // Keep the ticket server-side — the UI only learns that verification succeeded
      tickets.set(input.email, { ticket: r.json.ticket, expiresAt: Date.now() + TICKET_TTL_MS });
      return { ok: true };
    }
    return reply.status(r.status).send(r.json);
  });

  app.get("/api/tunnel/available", async (req, reply) => {
    const { name } = req.query as { name?: string };
    try {
      const res = await doFetch(
        new URL(`/v1/tunnels/available?name=${encodeURIComponent(name ?? "")}`, deps.serviceUrl),
        { signal: AbortSignal.timeout(15_000) },
      );
      return reply.status(res.status).send(await res.json().catch(() => null));
    } catch {
      return reply.status(502).send(unreachable);
    }
  });

  app.post("/api/tunnel/create", async (req, reply) => {
    const input = createBody.parse(req.body);
    if (!deps.runtime.available) {
      return reply.status(501).send({
        error: {
          code: "CLOUDFLARED_UNAVAILABLE",
          message: "cloudflared is not available in this install — the public address cannot run",
          details: null,
        },
      });
    }
    const held = tickets.get(input.email);
    if (!held || Date.now() > held.expiresAt) {
      return reply.status(401).send({
        error: { code: "TICKET_INVALID", message: "Verify your email again", details: null },
      });
    }
    const r = await relay("/v1/tunnels", {
      email: input.email,
      ticket: held.ticket,
      subdomain: input.subdomain,
      localPort: deps.localPort,
    });
    if (!r) return reply.status(502).send(unreachable);
    if (r.status !== 201 || !r.json) return reply.status(r.status).send(r.json);

    const { host, token, ownerToken, expiresAt } = r.json as {
      host: string; token: string; ownerToken?: string; expiresAt: number;
    };
    tickets.delete(input.email);
    await writeTunnelState(db, {
      host,
      token,
      ownerToken,
      email: input.email,
      expiresAt,
      enabled: true,
      remoteAdmin: false,
      createdAt: Date.now(),
    });
    deps.runtime.start(token);
    return reply.status(201).send({ host, expiresAt });
  });

  app.get("/api/tunnel/status", async () => {
    const state = await readTunnelState(db);
    return {
      configured: state !== null,
      enabled: state?.enabled ?? false,
      host: state?.host ?? null,
      expiresAt: state?.expiresAt ?? null,
      running: deps.runtime.running(),
      cloudflaredAvailable: deps.runtime.available,
      lastError: deps.runtime.lastError(),
      remoteAdmin: state?.remoteAdmin ?? false,
      /** Older addresses were issued before ownership proof existed — they cannot toggle */
      canToggleRemoteAdmin: !!state?.ownerToken,
    };
  });

  /** Local stop only — the address record stays; unsubscribe (via email) is what revokes it */
  app.post("/api/tunnel/disable", async (_req, reply) => {
    const state = await readTunnelState(db);
    if (!state) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "No public address is configured", details: null },
      });
    }
    deps.runtime.stop();
    await writeTunnelState(db, { ...state, enabled: false });
    return { ok: true };
  });

  /**
   * Open (or close) /admin and /api on the public address. The service puts Cloudflare
   * Access in front of those paths first, so this is not a bare hole: reaching the admin
   * from outside still costs an emailed code to the verified address.
   */
  app.post("/api/tunnel/remote-admin", async (req, reply) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      return reply.status(422).send({
        error: { code: "VALIDATION_ERROR", message: "enabled (boolean) is required", details: null },
      });
    }
    const state = await readTunnelState(db);
    if (!state) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "No public address is configured", details: null },
      });
    }
    if (!state.ownerToken) {
      // Issued before ownership proof existed — re-claiming the address is the only path
      return reply.status(409).send({
        error: {
          code: "OWNER_TOKEN_MISSING",
          message: "This address predates remote admin — claim a new address to use it",
          details: null,
        },
      });
    }
    const r = await relay("/v1/tunnels/remote-admin", {
      email: state.email,
      token: state.ownerToken,
      enabled,
    });
    if (!r) return reply.status(502).send(unreachable);
    if (r.status !== 200) return reply.status(r.status).send(r.json);
    await writeTunnelState(db, { ...state, remoteAdmin: enabled });
    return { remoteAdmin: enabled };
  });

  /** Re-enable after a local disable — reuses the stored token */
  app.post("/api/tunnel/enable", async (_req, reply) => {
    const state = await readTunnelState(db);
    if (!state) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "No public address is configured", details: null },
      });
    }
    if (Date.now() > state.expiresAt) {
      return reply.status(410).send({
        error: { code: "EXPIRED", message: "The address has expired", details: null },
      });
    }
    await writeTunnelState(db, { ...state, enabled: true });
    deps.runtime.start(state.token);
    return { ok: true };
  });
}

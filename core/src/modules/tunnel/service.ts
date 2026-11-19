/**
 * Public tunnel runtime (IMPL-public-tunnel) — cloudflared child process supervision
 * plus tunnel state persisted in instance_settings['tunnel'].
 *
 * Hosted assistants (claude.ai, ChatGPT) fetch MCP URLs from their own servers, so a
 * local install's http://localhost is structurally unreachable for them. The license
 * server provisions a named tunnel on *.prina.app and hands back a connector token;
 * this module keeps that token and runs cloudflared against it.
 *
 * Supervision mirrors the proven registry child-process pattern: spawn, restart with
 * backoff on crash, reset backoff after 30s of life. cloudflared reconnects on its own
 * when the network blips — we only restart when the process itself dies.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { instanceSettings } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";

const SETTINGS_KEY = "tunnel";

export interface TunnelState {
  host: string;
  /** cloudflared connector token — never leaves the server (browser only sees the host) */
  token: string;
  /**
   * Proof of ownership for later changes to this address (remote admin on/off).
   * Kept server-side like the connector token; it is deliberately not the unsubscribe
   * token, which rides in email links.
   */
  ownerToken?: string;
  /** /admin and /api reachable through the address, gated by Cloudflare Access */
  remoteAdmin?: boolean;
  email: string;
  expiresAt: number;
  /** false = user disabled locally; the record is kept for re-enabling */
  enabled: boolean;
  createdAt: number;
}

export async function readTunnelState(db: Db): Promise<TunnelState | null> {
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.key, SETTINGS_KEY))
    .limit(1);
  return (row?.value as TunnelState | undefined) ?? null;
}

export async function writeTunnelState(db: Db, state: TunnelState): Promise<void> {
  const record = state as unknown as Record<string, unknown>;
  await db
    .insert(instanceSettings)
    .values({ key: SETTINGS_KEY, value: record })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value: record } });
}

export interface TunnelRuntime {
  /** cloudflared binary was found at startup — when false, provisioning is pointless */
  available: boolean;
  running(): boolean;
  /** Launch (or relaunch with a new token). No-op when the binary is unavailable. */
  start(token: string): void;
  stop(): void;
  /** Last abnormal exit description — surfaced in /api/tunnel/status (§9 failure modes) */
  lastError(): string | null;
}

export interface TunnelRuntimeOptions {
  /** cloudflared binary path or name on PATH */
  bin: string;
  log: { info: (msg: string) => void; error: (msg: string) => void };
}

export function createTunnelRuntime(opts: TunnelRuntimeOptions): TunnelRuntime {
  const probe = spawnSync(opts.bin, ["--version"], { stdio: "ignore" });
  const available = probe.error === undefined && probe.status === 0;
  if (!available) opts.log.info(`[tunnel] cloudflared not found (${opts.bin}) — public address disabled`);

  let child: ChildProcess | null = null;
  let stopped = true;
  let currentToken: string | null = null;
  let restartDelayMs = 1000;
  let lastError: string | null = null;

  const launch = () => {
    if (stopped || !currentToken) return;
    // Token goes through env, not argv — argv is visible in the process list
    child = spawn(opts.bin, ["tunnel", "run"], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { PATH: process.env.PATH ?? "", TUNNEL_TOKEN: currentToken },
    });
    opts.log.info(`[tunnel] cloudflared started (pid ${child.pid})`);
    child.on("exit", (code, signal) => {
      if (stopped) return;
      lastError = `cloudflared exited (code=${code} signal=${signal})`;
      opts.log.error(`[tunnel] ${lastError} — restarting in ${restartDelayMs}ms`);
      setTimeout(launch, restartDelayMs).unref();
      restartDelayMs = Math.min(restartDelayMs * 2, 30_000);
    });
    // Reset backoff after 30s of survival
    setTimeout(() => {
      if (child && child.exitCode === null) {
        restartDelayMs = 1000;
        lastError = null;
      }
    }, 30_000).unref();
  };

  return {
    available,
    running: () => child !== null && child.exitCode === null && !stopped,
    start(token) {
      if (!available) return;
      if (!stopped && currentToken === token && child && child.exitCode === null) return;
      if (!stopped) {
        stopped = true;
        child?.kill("SIGTERM");
      }
      currentToken = token;
      stopped = false;
      restartDelayMs = 1000;
      launch();
    },
    stop() {
      stopped = true;
      child?.kill("SIGTERM");
      child = null;
    },
    lastError: () => lastError,
  };
}

/** Boot-time reconnect — a restart must not silently drop the public address (§3.2) */
export async function resumeTunnel(db: Db, runtime: TunnelRuntime): Promise<void> {
  const state = await readTunnelState(db);
  if (state?.enabled && state.token && state.expiresAt > Date.now()) {
    runtime.start(state.token);
  }
}

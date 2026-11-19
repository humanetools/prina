/**
 * The address the request really came from — for decisions that grant something by network location
 * (46-IMPL G6 Safe Zone). `req.ip` is not enough: with TRUST_PROXY it follows X-Forwarded-For, whose
 * leftmost entry the client writes itself.
 *
 * 1. PRINA_CLIENT_IP_HEADER names a header the operator's own proxy overwrites (e.g. "x-real-ip").
 * 2. On Fly (FLY_APP_NAME is set) the edge writes Fly-Client-IP — the peer that connected to Fly.
 * 3. Otherwise the peer is req.ip (the socket address, or the proxy chain when TRUST_PROXY is on).
 * 4. When that peer is a Cloudflare edge, the visitor is in CF-Connecting-IP. The header is believed
 *    only from Cloudflare's published ranges, so sending it straight to the origin gains nothing.
 */
import { BlockList, isIP } from "node:net";
import type { FastifyRequest } from "fastify";

// https://www.cloudflare.com/ips/ (checked 2026-11-15)
const CLOUDFLARE_V4 = [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
  "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
  "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
];
const CLOUDFLARE_V6 = [
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
  "2a06:98c0::/29", "2c0f:f248::/32",
];

const cloudflare = new BlockList();
for (const c of CLOUDFLARE_V4) cloudflare.addSubnet(c.split("/")[0]!, Number(c.split("/")[1]), "ipv4");
for (const c of CLOUDFLARE_V6) cloudflare.addSubnet(c.split("/")[0]!, Number(c.split("/")[1]), "ipv6");

/** "::ffff:203.0.113.7" → "203.0.113.7"; anything that is not an address → null */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  return isIP(ip) ? ip : null;
}

export const ipFamily = (ip: string): "ipv4" | "ipv6" => (isIP(ip) === 6 ? "ipv6" : "ipv4");

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export function resolveClientIp(req: FastifyRequest, env: NodeJS.ProcessEnv = process.env): string | null {
  const custom = env.PRINA_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (custom) return normalizeIp(header(req, custom));
  const peer = (env.FLY_APP_NAME ? normalizeIp(header(req, "fly-client-ip")) : null) ?? normalizeIp(req.ip);
  if (!peer) return null;
  if (cloudflare.check(peer, ipFamily(peer))) return normalizeIp(header(req, "cf-connecting-ip")) ?? peer;
  return peer;
}

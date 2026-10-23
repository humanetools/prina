/**
 * Rendition proxy (IMPL-saas-cloud §3 ⑥) — `GET|HEAD /img/*` → `${IMGPROXY_URL}/*`.
 *
 * imgproxy listens on an internal address (127.0.0.1 in the hosted image, the compose
 * service name on-prem) that a browser can never reach, so rendition URLs are issued
 * against this route and forwarded here. No auth: imgproxy validates the HMAC signature
 * embedded in the path, and its 403 for a bad signature is passed through unchanged.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Readable } from "node:stream";

const UPSTREAM_TIMEOUT_MS = 30_000;

/** Conditional-request headers forwarded upstream so imgproxy can answer 304 itself */
const REQUEST_HEADERS = ["if-none-match", "if-modified-since", "accept"] as const;
/** Response headers copied back verbatim */
const RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "cache-control",
  "etag",
  "last-modified",
  "vary",
] as const;

/** Signed rendition URLs are content-addressed by storage key, so a long immutable TTL is safe */
const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function registerImgRoutes(app: FastifyInstance, imgproxyUrl: string): void {
  const upstreamBase = imgproxyUrl.replace(/\/+$/, "");

  async function proxy(req: FastifyRequest, reply: FastifyReply) {
    const rest = (req.params as { "*": string })["*"];
    const headers: Record<string, string> = {};
    for (const name of REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(`${upstreamBase}/${rest}`, {
        method: req.method,
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      req.log.warn({ err }, "imgproxy upstream unreachable");
      return reply.status(502).send({
        error: { code: "UPSTREAM_UNAVAILABLE", message: "Image service is unreachable", details: null },
      });
    }

    reply.status(upstream.status);
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) reply.header(name, value);
    }
    if (upstream.status === 200 && !upstream.headers.has("cache-control")) {
      reply.header("cache-control", DEFAULT_CACHE_CONTROL);
    }

    // HEAD and 304 carry no body — release the upstream connection and finish
    if (req.method === "HEAD" || upstream.status === 304 || !upstream.body) {
      clearTimeout(timer);
      await upstream.body?.cancel();
      return reply.send();
    }
    // The timeout also covers a stalled body: aborting destroys the stream and the response
    const body = Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream);
    body.once("close", () => clearTimeout(timer));
    return reply.send(body);
  }

  app.route({ method: ["GET", "HEAD"], url: "/img/*", handler: proxy });
}

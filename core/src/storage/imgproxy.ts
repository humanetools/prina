/**
 * imgproxy signed URL generation (T4.2) — the sidecar reads the S3 bucket as its source.
 * URL format: {base}/{sig}/{processing}/{base64url(source)}
 * sig = base64url(HMAC-SHA256(key=hex(KEY), data=hex(SALT) + path))
 */
import { createHmac } from "node:crypto";

export interface RenditionPreset {
  name: string;
  /** fit | fill */
  resize: "fit" | "fill";
  width: number;
  height: number;
}

/** Default rendition presets — overridable via workspace settings.renditions (T4.2) */
export const DEFAULT_RENDITIONS: RenditionPreset[] = [
  { name: "thumb", resize: "fill", width: 200, height: 200 },
  { name: "small", resize: "fit", width: 480, height: 480 },
  { name: "medium", resize: "fit", width: 1024, height: 1024 },
  { name: "large", resize: "fit", width: 2048, height: 2048 },
];

export interface ImgproxyConfig {
  /** Public base of rendition URLs — relative path (`/img`) or absolute origin+path; a trailing slash is tolerated */
  baseUrl: string;
  /** Hex-encoded key/salt (same values as docker-compose IMGPROXY_KEY/SALT) */
  keyHex: string;
  saltHex: string;
  bucket: string;
}

export function createImgproxySigner(cfg: ImgproxyConfig) {
  const key = Buffer.from(cfg.keyHex, "hex");
  const salt = Buffer.from(cfg.saltHex, "hex");
  // Normalized once: no trailing slash, so `${base}/${sig}${path}` joins cleanly whether
  // the base is "/img", "/img/", "https://host/img" or "https://host/img/"
  const base = cfg.baseUrl.replace(/\/+$/, "");

  function sign(path: string): string {
    return createHmac("sha256", key)
      .update(Buffer.concat([salt, Buffer.from(path)]))
      .digest("base64url");
  }

  function renditionUrl(storageKey: string, preset: RenditionPreset): string {
    const source = Buffer.from(`s3://${cfg.bucket}/${storageKey}`).toString("base64url");
    const path = `/rs:${preset.resize}:${preset.width}:${preset.height}/${source}`;
    return `${base}/${sign(path)}${path}`;
  }

  return { renditionUrl, sign };
}

export type ImgproxySigner = ReturnType<typeof createImgproxySigner>;

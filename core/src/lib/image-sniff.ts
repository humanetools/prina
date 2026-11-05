/**
 * Container sniffing for uploaded images. The declared MIME is client-supplied, while imgproxy
 * picks the decoder from the magic bytes — so an upload declared as PNG can still be decoded as
 * JPEG XL. imgproxy reaches libjxl → Brotli for that format, and Brotli < 1.2.1 has a remote code
 * execution flaw (CVE-2026-111497) that no imgproxy image has shipped a fix for yet (2026-10-23).
 * Prina has no JPEG XL rendition of its own, so the format is refused at upload rather than
 * handed to the sidecar. Drop the guard once the imgproxy pin carries Brotli ≥ 1.2.1.
 */

/** Bare JPEG XL codestream signature */
const JXL_CODESTREAM = Buffer.from([0xff, 0x0a]);
/** ISOBMFF-wrapped JPEG XL: box size 12, type "JXL ", then the fixed signature */
const JXL_CONTAINER = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);

export function isJpegXl(buf: Buffer): boolean {
  return (
    buf.subarray(0, JXL_CODESTREAM.length).equals(JXL_CODESTREAM) ||
    buf.subarray(0, JXL_CONTAINER.length).equals(JXL_CONTAINER)
  );
}

/** MIME types that name JPEG XL outright — refused before a presigned URL is issued */
export const JPEG_XL_MIMES = new Set(["image/jxl"]);

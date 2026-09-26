/** Image dimensions/EXIF extraction (T4.1) — server reads the object on confirm */
import { imageSize } from "image-size";
import exifr from "exifr";

/** Max bytes read for metadata extraction (dimensions/EXIF live at the file start) */
export const METADATA_READ_BYTES = 8 * 1024 * 1024;

export interface ExtractedImageMeta {
  width: number | null;
  height: number | null;
  exif: Record<string, unknown>;
}

const EXIF_KEEP = [
  "Make", "Model", "LensModel", "FNumber", "ExposureTime", "ISO",
  "FocalLength", "DateTimeOriginal", "Orientation", "ColorSpace",
  "latitude", "longitude",
];

export async function extractImageMeta(buffer: Buffer): Promise<ExtractedImageMeta> {
  let width: number | null = null;
  let height: number | null = null;
  try {
    const dim = imageSize(buffer);
    width = dim.width ?? null;
    height = dim.height ?? null;
  } catch {
    /* Not an image, or unsupported format */
  }

  let exif: Record<string, unknown> = {};
  try {
    const parsed = (await exifr.parse(buffer)) as Record<string, unknown> | undefined;
    if (parsed) {
      exif = Object.fromEntries(
        EXIF_KEEP.filter((k) => parsed[k] !== undefined).map((k) => [
          k,
          parsed[k] instanceof Date ? (parsed[k] as Date).toISOString() : parsed[k],
        ]),
      );
    }
  } catch {
    /* No EXIF data */
  }
  return { width, height, exif };
}

/**
 * Delivery draft token (T5.5) — for external integrations like Next.js Draft Mode.
 * Signing secret is generated once and persisted in instance_settings (tokens survive restarts).
 * Format: dt1.<workspaceSlug>.<expiry epoch secs>.<HMAC>
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { instanceSettings } from "../../db/schema/index.js";
import type { Db } from "../../db/client.js";

let cachedSecret: string | null = null;

export async function getDeliverySecret(db: Db): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const [row] = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.key, "delivery_secret"))
    .limit(1);
  if (row) {
    cachedSecret = (row.value as { secret: string }).secret;
    return cachedSecret;
  }
  const secret = randomBytes(32).toString("base64url");
  await db
    .insert(instanceSettings)
    .values({ key: "delivery_secret", value: { secret } })
    .onConflictDoNothing();
  cachedSecret = secret;
  return secret;
}

function sign(secret: string, wsSlug: string, exp: number): string {
  return createHmac("sha256", secret).update(`${wsSlug}.${exp}`).digest("base64url");
}

export async function issueDraftToken(
  db: Db,
  wsSlug: string,
  expiresInHours: number,
): Promise<{ token: string; expiresAt: string }> {
  const secret = await getDeliverySecret(db);
  const exp = Math.floor(Date.now() / 1000) + Math.floor(expiresInHours * 3600);
  return {
    token: `dt1.${wsSlug}.${exp}.${sign(secret, wsSlug, exp)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export async function verifyDraftToken(
  db: Db,
  token: string,
  wsSlug: string,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "dt1" || parts[1] !== wsSlug) return false;
  const exp = Number(parts[2]);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const secret = await getDeliverySecret(db);
  const expected = Buffer.from(sign(secret, wsSlug, exp));
  const actual = Buffer.from(parts[3]!);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

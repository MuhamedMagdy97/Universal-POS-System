import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for the inventory-system API key (integration spec I3).
 * Sealed layout: iv (12) | ciphertext | tag (16). Pure; the key comes from the caller.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function seal(plain: string, key: Buffer): Uint8Array<ArrayBuffer> {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, body, cipher.getAuthTag()]));
}

/** Throws on a wrong key or a tampered value (GCM authentication). */
export function open(sealed: Uint8Array, key: Buffer): string {
  const buf = Buffer.from(sealed);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(IV_BYTES, buf.length - TAG_BYTES)), decipher.final()]).toString(
    "utf8",
  );
}

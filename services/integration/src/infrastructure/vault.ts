import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { AppError } from "@visualsprint/platform";
import type { TokenVault } from "../application/ports.js";
const base64 = z
  .string()
  .max(100_000)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const envelope = z
  .object({
    v: z.literal(1),
    kid: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/),
    iv: base64,
    tag: base64,
    data: base64,
  })
  .strict();
export class AesTokenVault implements TokenVault {
  private readonly keys = new Map<string, Buffer>();
  constructor(
    private readonly currentKeyId: string,
    keys: Record<string, string>,
  ) {
    if (Object.keys(keys).length < 1 || Object.keys(keys).length > 3)
      throw new Error("INVALID_TOKEN_KEY_CONFIGURATION");
    for (const [kid, encoded] of Object.entries(keys)) {
      const key = Buffer.from(base64.parse(encoded), "base64");
      if (
        !/^[A-Za-z0-9_-]{1,60}$/.test(kid) ||
        key.length !== 32 ||
        key.toString("base64") !== encoded
      )
        throw new Error("INVALID_TOKEN_KEY_CONFIGURATION");
      this.keys.set(kid, key);
    }
    if (!this.keys.has(currentKeyId)) throw new Error("INVALID_TOKEN_KEY_CONFIGURATION");
  }
  seal(value: unknown, context: string) {
    const plain = JSON.stringify(value);
    if (!plain || Buffer.byteLength(plain) > 64000) throw new Error("INVALID_TOKEN_PAYLOAD");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.currentKeyId)!, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return JSON.stringify({
      v: 1,
      kid: this.currentKeyId,
      iv: iv.toString("base64"),
      data: data.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    });
  }
  open(value: string, context: string): unknown {
    try {
      const parsed = envelope.parse(JSON.parse(z.string().max(100_000).parse(value)));
      const key = this.keys.get(parsed.kid);
      if (!key) throw new Error("KEY_UNAVAILABLE");
      const iv = Buffer.from(parsed.iv, "base64"),
        tag = Buffer.from(parsed.tag, "base64");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("INVALID_ENVELOPE");
      const cipher = createDecipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(tag);
      return JSON.parse(
        Buffer.concat([cipher.update(Buffer.from(parsed.data, "base64")), cipher.final()]).toString(
          "utf8",
        ),
      );
    } catch {
      throw new AppError("TOKEN_STORE_UNAVAILABLE", 503);
    }
  }
}

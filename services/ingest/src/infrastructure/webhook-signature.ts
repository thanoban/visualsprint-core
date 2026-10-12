import { createHmac, timingSafeEqual } from "node:crypto";

type Headers = Record<string, string | string[] | undefined>;
const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class RecallSignatures {
  private readonly keys: readonly Buffer[];
  constructor(
    secrets: readonly string[],
    private readonly prefix: "webhook" | "svix" = "webhook",
  ) {
    if (secrets.length < 1 || secrets.length > 2) throw new Error("INVALID_WEBHOOK_CONFIGURATION");
    this.keys = secrets.map((secret) => {
      const encoded = secret.startsWith("whsec_") ? secret.slice(6) : "";
      const key = Buffer.from(encoded, "base64");
      if (
        !base64.test(encoded) ||
        key.length < 32 ||
        key.length > 128 ||
        key.toString("base64") !== encoded
      )
        throw new Error("INVALID_WEBHOOK_CONFIGURATION");
      return key;
    });
  }
  verify(headers: Headers, payload: Buffer, nowSeconds = Math.floor(Date.now() / 1000)): string {
    const messageId = headers[`${this.prefix}-id`];
    const timestamp = headers[`${this.prefix}-timestamp`];
    const signatures = headers[`${this.prefix}-signature`];
    if (
      typeof messageId !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(messageId) ||
      typeof timestamp !== "string" ||
      !/^[0-9]{1,13}$/.test(timestamp) ||
      typeof signatures !== "string" ||
      signatures.length > 2048 ||
      payload.length > 1_000_000 ||
      !Number.isSafeInteger(nowSeconds) ||
      Math.abs(nowSeconds - Number(timestamp)) > 300
    )
      throw new Error("INVALID_WEBHOOK_SIGNATURE");
    const content = Buffer.concat([Buffer.from(`${messageId}.${timestamp}.`, "utf8"), payload]);
    const expected = this.keys.map((key) => createHmac("sha256", key).update(content).digest());
    let matched = false;
    for (const item of signatures.split(" ")) {
      const [version, encoded, extra] = item.split(",");
      if (version !== "v1" || !encoded || extra !== undefined || !base64.test(encoded)) continue;
      const signature = Buffer.from(encoded, "base64");
      if (signature.length !== 32 || signature.toString("base64") !== encoded) continue;
      for (const digest of expected) matched = timingSafeEqual(digest, signature) || matched;
    }
    if (!matched) throw new Error("INVALID_WEBHOOK_SIGNATURE");
    return messageId;
  }
}

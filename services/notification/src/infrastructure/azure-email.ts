import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson } from "@visualsprint/platform";
import type { EmailPort } from "../application/ports.js";
import type { EmailResult, EmailLookup } from "../domain/notification.js";
export interface EmailCredential {
  getToken(
    scopes: string | string[],
    options?: { abortSignal?: AbortSignal },
  ): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}
const result = z.object({
  id: z.string().uuid(),
  status: z.enum(["NotStarted", "Running", "Succeeded", "Failed", "Canceled"]),
});
const apiVersion = "2025-09-01";
const scope = "https://communication.azure.com//.default";
export class AzureCommunicationEmail implements EmailPort {
  readonly configured = true;
  private readonly endpoint: URL;
  private readonly web: URL;
  private prepared: { token: string; expiresOnTimestamp: number } | null = null;
  constructor(
    endpoint: string,
    private readonly sender: string,
    private readonly credential: EmailCredential,
    webOrigin: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.endpoint = new URL(endpoint);
    this.web = new URL(webOrigin);
    if (
      this.endpoint.protocol !== "https:" ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.port ||
      this.endpoint.pathname !== "/" ||
      this.endpoint.search ||
      this.endpoint.hash ||
      !/^([a-z0-9][a-z0-9-]*\.)+communication\.azure\.com$/.test(this.endpoint.hostname)
    )
      throw new Error("INVALID_EMAIL_ENDPOINT");
    z.string().max(320).email().parse(sender);
    if (
      this.web.protocol !== "https:" ||
      this.web.username ||
      this.web.password ||
      this.web.pathname !== "/" ||
      this.web.search ||
      this.web.hash
    )
      throw new Error("INVALID_EMAIL_APP_ORIGIN");
  }
  private operation(deliveryId: string) {
    return new URL(
      `/emails/operations/${id.parse(deliveryId)}?api-version=${apiVersion}`,
      this.endpoint,
    );
  }
  private async token() {
    if (this.prepared && this.prepared.expiresOnTimestamp > Date.now() + 10000)
      return this.prepared.token;
    let token: { token: string; expiresOnTimestamp: number } | null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    try {
      token = await Promise.race([
        this.credential.getToken(scope, { abortSignal: abort.signal }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error("IDENTITY_DEADLINE"));
          }, 2000);
        }),
      ]);
    } catch {
      throw new AppError("EMAIL_IDENTITY_UNAVAILABLE", 503);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!token?.token || token.expiresOnTimestamp <= Date.now())
      throw new AppError("EMAIL_IDENTITY_UNAVAILABLE", 503);
    this.prepared = token;
    return token.token;
  }
  async prepare() {
    await this.token();
  }
  private async parse(response: Response, deliveryId: string) {
    const parsed = result.parse(await boundedJson(response, 16000));
    if (parsed.id.toLowerCase() !== deliveryId.toLowerCase())
      throw new Error("EMAIL_OPERATION_MISMATCH");
    return parsed;
  }
  private convert(status: z.infer<typeof result>["status"], deliveryId: string): EmailLookup {
    if (status === "Succeeded") return { state: "sent", externalId: deliveryId };
    if (status === "Failed" || status === "Canceled")
      return {
        state: "rejected",
        code: status === "Failed" ? "EMAIL_SEND_FAILED" : "EMAIL_SEND_CANCELLED",
      };
    return { state: "pending" };
  }
  async send(input: {
    deliveryId: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<EmailResult> {
    id.parse(input.deliveryId);
    z.string().max(320).email().parse(input.to);
    const prefix = "An update is ready in your VisualSprint workspace. Open ";
    if (input.subject !== "Your VisualSprint update is ready" || !input.text.startsWith(prefix))
      throw new AppError("EMAIL_TEMPLATE_INVALID", 400);
    let link: URL;
    try {
      link = new URL(input.text.slice(prefix.length));
    } catch {
      throw new AppError("EMAIL_TEMPLATE_INVALID", 400);
    }
    if (
      link.origin !== this.web.origin ||
      link.username ||
      link.password ||
      link.search ||
      link.hash ||
      !/^\/w\/[0-9a-f-]{36}$/i.test(link.pathname) ||
      !id.safeParse(link.pathname.slice(3)).success ||
      input.text !== prefix + link.toString()
    )
      throw new AppError("EMAIL_TEMPLATE_INVALID", 400);
    const token = await this.token();
    let response: Response;
    try {
      response = await this.transport(
        new URL(`/emails:send?api-version=${apiVersion}`, this.endpoint),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "Operation-Id": input.deliveryId,
            "x-ms-client-request-id": input.deliveryId,
          },
          body: JSON.stringify({
            senderAddress: this.sender,
            content: { subject: input.subject, plainText: input.text },
            recipients: { to: [{ address: input.to }] },
            userEngagementTrackingDisabled: true,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(5000),
        },
      );
    } catch {
      return { state: "unknown" };
    }
    if (response.status !== 202) {
      await response.body?.cancel();
      if ([400, 401, 403, 422].includes(response.status))
        return {
          state: "rejected",
          code:
            response.status === 401 || response.status === 403
              ? "EMAIL_CONFIGURATION"
              : "EMAIL_REQUEST_REJECTED",
        };
      return { state: "unknown" };
    }
    try {
      const location = response.headers.get("operation-location");
      if (location) {
        const expected = this.operation(input.deliveryId),
          actual = new URL(location);
        if (
          actual.origin !== expected.origin ||
          actual.pathname.toLowerCase() !== expected.pathname.toLowerCase() ||
          actual.username ||
          actual.password ||
          actual.hash ||
          actual.search !== expected.search
        )
          throw new Error("INVALID_OPERATION_LOCATION");
      }
      const parsed = await this.parse(response, input.deliveryId);
      const converted = this.convert(parsed.status, input.deliveryId);
      return converted.state === "pending" || converted.state === "not_sent"
        ? { state: "unknown" }
        : converted;
    } catch {
      return { state: "unknown" };
    }
  }
  async lookup(deliveryId: string): Promise<EmailLookup> {
    id.parse(deliveryId);
    const token = await this.token();
    let response: Response;
    try {
      response = await this.transport(this.operation(deliveryId), {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return { state: "pending" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { state: "pending" };
    }
    try {
      return this.convert((await this.parse(response, deliveryId)).status, deliveryId);
    } catch {
      return { state: "pending" };
    }
  }
}

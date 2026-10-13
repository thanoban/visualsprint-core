import { AppError, boundedJson, serviceToken, type Actor } from "@visualsprint/platform";
import { executionInput, type WorkflowApproval } from "../application/action-executions.js";
export class HttpWorkflowApproval implements WorkflowApproval {
  constructor(
    private readonly origin: string,
    private readonly key: CryptoKey,
    private readonly keyId: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    const u = new URL(origin);
    if (
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/" ||
      (u.protocol !== "https:" &&
        !(
          process.env.NODE_ENV !== "production" &&
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(u.hostname)
        ))
    )
      throw new Error("INVALID_WORKFLOW_ORIGIN");
  }
  private async read(actor: Actor, operationId: string, suffix: string) {
    const token = await serviceToken({
      caller: "integration",
      audience: "workflow",
      actor,
      privateKey: this.key,
      keyId: this.keyId,
    });
    let response: Response;
    try {
      response = await this.transport(
        new URL(
          `/internal/workspaces/${actor.workspaceId}/operations/${operationId}/${suffix}`,
          this.origin,
        ),
        {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(4000),
        },
      );
    } catch {
      throw new AppError("WORKFLOW_AUTHORITY_UNAVAILABLE", 503);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        "ACTION_APPROVAL_NOT_VALID",
        [401, 403, 404, 409].includes(response.status) ? response.status : 503,
      );
    }
    try {
      return executionInput.parse(await boundedJson(response, 24000));
    } catch {
      throw new AppError("WORKFLOW_AUTHORITY_UNAVAILABLE", 503);
    }
  }
  proof(actor: Actor, operationId: string) {
    return this.read(actor, operationId, "approval");
  }
  reference(actor: Actor, operationId: string) {
    return this.read(actor, operationId, "reference-context");
  }
}

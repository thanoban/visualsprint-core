import { z } from "zod";
import { id } from "@visualsprint/contracts";

export const workspaceSchema = z.object({ id, name: z.string(), cellId: z.string() });
export const meSchema = z.object({ userId: id, workspaces: z.array(workspaceSchema) });
export const customerSchema = z.object({
  id,
  workspaceId: id,
  ownerId: id,
  name: z.string(),
  version: z.number().int(),
});
export const projectSchema = customerSchema.extend({ customerId: id.nullable() });
export const meetingSchema = z.object({
  id,
  workspaceId: id,
  ownerId: id,
  title: z.string(),
  notes: z.string(),
  joinUrl: z.string().nullable(),
  version: z.number().int(),
  blocked: z.boolean(),
  createdAt: z.string(),
});
export const memberSchema = z.object({
  userId: id,
  role: z.enum(["owner", "member"]),
  active: z.boolean(),
  version: z.number().int(),
});
export type Workspace = z.infer<typeof workspaceSchema>;
export type Customer = z.infer<typeof customerSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Meeting = z.infer<typeof meetingSchema>;
export type Member = z.infer<typeof memberSchema>;

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session has ended. Sign in again to continue.";
    if (error.status === 403 || error.status === 404)
      return "This item is no longer available to you. Refresh your workspace.";
    if (error.status === 409)
      return "This item changed while you were editing. Refresh before saving again.";
    if (error.status === 429) return "Too many requests. Please try again shortly.";
    if (error.status >= 500)
      return "The service is temporarily unavailable. Your session is still signed in; please retry.";
    return "The request could not be accepted. Check the fields and try again.";
  }
  return "Unable to connect. Please check your connection and retry.";
}
export class Api {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly transport: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      method?: "GET" | "POST" | "PATCH" | "DELETE";
      body?: unknown;
      key?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    // Credentials cannot be sent to a client-supplied URL or a different origin.
    if (
      !path.startsWith("/api/v3/") ||
      path.includes("\\") ||
      path.includes("#") ||
      !new URL(path, "https://same-origin.invalid").pathname.startsWith("/api/v3/")
    )
      throw new Error("INVALID_API_PATH");
    const token = await this.getAccessToken();
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.key) headers["idempotency-key"] = options.key;
    const response = await this.transport(path, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: options.signal ?? AbortSignal.timeout(10_000),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) throw new ApiError("REQUEST_FAILED", response.status);
    return schema.parse(await response.json());
  }
  scope(workspaceId: string) {
    return `/api/v3/workspaces/${id.parse(workspaceId)}`;
  }
  me(signal?: AbortSignal) {
    return this.request("/api/v3/me", meSchema, signal ? { signal } : {});
  }
  createWorkspace(name: string, key: string) {
    return this.request("/api/v3/workspaces", workspaceSchema, {
      method: "POST",
      body: { name },
      key,
    });
  }
  customers(workspaceId: string, signal: AbortSignal) {
    return this.request(`${this.scope(workspaceId)}/customers`, z.array(customerSchema), {
      signal,
    });
  }
  projects(workspaceId: string, signal: AbortSignal) {
    return this.request(`${this.scope(workspaceId)}/projects`, z.array(projectSchema), { signal });
  }
  meetings(workspaceId: string, projectId: string | undefined, signal: AbortSignal) {
    return this.request(
      `${this.scope(workspaceId)}/meetings${projectId ? `?projectId=${id.parse(projectId)}` : ""}`,
      z.array(meetingSchema),
      { signal },
    );
  }
  meeting(workspaceId: string, meetingId: string, signal: AbortSignal) {
    return this.request(
      `${this.scope(workspaceId)}/meetings/${id.parse(meetingId)}`,
      meetingSchema,
      { signal },
    );
  }
  members(workspaceId: string, signal: AbortSignal) {
    return this.request(`${this.scope(workspaceId)}/members`, z.array(memberSchema), { signal });
  }
  logout() {
    return this.request("/api/v3/logout", z.object({ revoked: z.literal(true) }), {
      method: "POST",
    });
  }
}

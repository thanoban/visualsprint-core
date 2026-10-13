import { z } from "zod";
import { id } from "@visualsprint/contracts";
import { AppError, boundedJson } from "@visualsprint/platform";
import {
  actionFingerprint,
  type ActionConnection,
  type ActionProvider,
  type ExecutionIntent,
  type ExecutionResult,
} from "../application/action-executions.js";
const githubVersion = "2026-03-10";
const adf = (description: string) => ({
  type: "doc",
  version: 1,
  content: description
    .split("\n")
    .map((text) => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] })),
});
const jiraConfig = z
  .object({
    provider: z.literal("jira"),
    cloudId: id,
    projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/),
    issueTypeId: z.string().regex(/^[0-9]{1,30}$/),
  })
  .strict();
const githubConfig = z
  .object({
    provider: z.literal("github"),
    repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  })
  .strict();
const linearConfig = z
  .object({ provider: z.literal("linear"), teamId: id, authMode: z.enum(["oauth", "api_key"]) })
  .strict();
const issueGithub = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  updated_at: z.string().datetime(),
  pull_request: z.unknown().optional(),
});
const issueLinear = z.object({
  id,
  title: z.string(),
  description: z.string().nullable(),
  team: z.object({ id }),
  state: z.object({ type: z.string(), name: z.string() }),
  updatedAt: z.string().datetime(),
});
export class HttpActionProvider implements ActionProvider {
  constructor(private readonly transport: typeof fetch = fetch) {}
  private async call(
    url: string,
    credential: string,
    method: "GET" | "POST",
    body?: unknown,
    linearAuthMode?: "oauth" | "api_key",
  ) {
    return this.transport(url, {
      method,
      headers: {
        authorization: linearAuthMode === "api_key" ? credential : `Bearer ${credential}`,
        accept: url.startsWith("https://api.github.com/")
          ? "application/vnd.github+json"
          : "application/json",
        "content-type": "application/json",
        ...(url.startsWith("https://api.github.com/")
          ? { "x-github-api-version": githubVersion }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(4000),
    });
  }
  async create(
    connection: ActionConnection,
    credential: string,
    intent: ExecutionIntent,
  ): Promise<ExecutionResult> {
    if (connection.provider !== intent.provider || connection.destination !== intent.destination)
      return { state: "rejected", code: "DESTINATION_MISMATCH" };
    if (intent.provider !== "jira" && intent.payload.dueDate !== null)
      return { state: "rejected", code: "UNSUPPORTED_DUE_DATE" };
    try {
      let response: Response;
      if (intent.provider === "github") {
        const config = githubConfig.parse(connection.configuration);
        if (
          config.repository !== intent.destination ||
          config.repository.split("/").some((part) => [".", ".."].includes(part))
        )
          return { state: "rejected", code: "DESTINATION_MISMATCH" };
        response = await this.call(
          `https://api.github.com/repos/${config.repository}/issues`,
          credential,
          "POST",
          { title: intent.payload.title, body: intent.payload.description },
        );
        if (response.status === 201) {
          const body = z
            .object({ number: z.number().int().positive() })
            .parse(await boundedJson(response, 64000));
          return { state: "confirmed", externalId: String(body.number) };
        }
      } else if (intent.provider === "jira") {
        const config = jiraConfig.parse(connection.configuration);
        if (config.projectKey !== intent.destination)
          return { state: "rejected", code: "DESTINATION_MISMATCH" };
        response = await this.call(
          `https://api.atlassian.com/ex/jira/${config.cloudId}/rest/api/3/issue`,
          credential,
          "POST",
          {
            fields: {
              project: { key: config.projectKey },
              issuetype: { id: config.issueTypeId },
              summary: intent.payload.title,
              description: adf(intent.payload.description),
              ...(intent.payload.dueDate ? { duedate: intent.payload.dueDate } : {}),
            },
          },
        );
        if (response.status === 201) {
          const body = z
            .object({
              id: z.string().regex(/^[0-9]+$/),
              key: z.string().regex(/^[A-Z][A-Z0-9_]*-[0-9]+$/),
            })
            .parse(await boundedJson(response, 64000));
          return { state: "confirmed", externalId: body.key };
        }
      } else {
        const config = linearConfig.parse(connection.configuration);
        if (config.teamId !== intent.destination)
          return { state: "rejected", code: "DESTINATION_MISMATCH" };
        response = await this.call(
          "https://api.linear.app/graphql",
          credential,
          "POST",
          {
            query:
              "mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id } } }",
            variables: {
              input: {
                teamId: config.teamId,
                title: intent.payload.title,
                description: intent.payload.description,
              },
            },
          },
          config.authMode,
        );
        if (response.ok) {
          const body = z
            .object({
              data: z
                .object({
                  issueCreate: z.object({
                    success: z.boolean(),
                    issue: z.object({ id }).nullable(),
                  }),
                })
                .optional(),
              errors: z.array(z.unknown()).optional(),
            })
            .parse(await boundedJson(response, 64000));
          if (body.errors?.length) return { state: "unknown" };
          if (body.data?.issueCreate.success && body.data.issueCreate.issue)
            return { state: "confirmed", externalId: body.data.issueCreate.issue.id };
          return { state: "unknown" };
        }
      }
      if ([400, 401, 403, 404, 410, 422, 429].includes(response.status)) {
        await response.body?.cancel();
        return {
          state: "rejected",
          code: response.status === 429 ? "PROVIDER_RATE_LIMITED" : "PROVIDER_REJECTED",
        };
      }
      await response.body?.cancel();
      return { state: "unknown" };
    } catch {
      return { state: "unknown" };
    }
  }
  private async record(connection: ActionConnection, credential: string, externalId: string) {
    let response: Response;
    try {
      if (connection.provider === "github") {
        const c = githubConfig.parse(connection.configuration);
        if (
          c.repository !== connection.destination ||
          c.repository.split("/").some((part) => [".", ".."].includes(part))
        )
          throw new AppError("EXTERNAL_LOOKUP_UNAVAILABLE", 503);
        const number = z
          .string()
          .regex(/^[1-9][0-9]{0,15}$/)
          .parse(externalId);
        response = await this.call(
          `https://api.github.com/repos/${c.repository}/issues/${number}`,
          credential,
          "GET",
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new AppError("EXTERNAL_LOOKUP_UNAVAILABLE", 503);
        }
        const body = issueGithub.parse(await boundedJson(response, 64000));
        if (String(body.number) !== externalId || body.pull_request)
          throw new AppError("EXTERNAL_LOOKUP_UNAVAILABLE", 503);
        return {
          provider: "github" as const,
          body,
          configuration: c,
        };
      }
      if (connection.provider === "jira") {
        const c = jiraConfig.parse(connection.configuration),
          issueKey = z
            .string()
            .regex(/^(?:[A-Z][A-Z0-9_]*-[0-9]+|[0-9]+)$/)
            .parse(externalId);
        response = await this.call(
          `https://api.atlassian.com/ex/jira/${c.cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,duedate,project,issuetype,status,updated`,
          credential,
          "GET",
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new AppError("EXTERNAL_LOOKUP_UNAVAILABLE", 503);
        }
        const body = z
          .object({
            id: z.string(),
            key: z.string(),
            fields: z.object({
              summary: z.string(),
              description: z.unknown(),
              duedate: z.string().nullable().optional(),
              project: z.object({ key: z.string() }),
              issuetype: z.object({ id: z.string() }),
              status: z.object({ name: z.string(), statusCategory: z.object({ key: z.string() }) }),
              updated: z.string(),
            }),
          })
          .parse(await boundedJson(response, 64000));
        if (
          (body.id !== externalId && body.key !== externalId) ||
          body.fields.project.key !== connection.destination ||
          c.projectKey !== connection.destination
        )
          throw new AppError("EXTERNAL_LOOKUP_UNAVAILABLE", 503);
        return { provider: "jira" as const, body, configuration: c };
      }
      const c = linearConfig.parse(connection.configuration);
      response = await this.call(
        "https://api.linear.app/graphql",
        credential,
        "POST",
        {
          query:
            "query IssueReference($id: String!) { issue(id: $id) { id title description team { id } state { type name } updatedAt } }",
          variables: { id: id.parse(externalId) },
        },
        c.authMode,
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError("EXTERNAL_LOOKUP_UNAVAILABLE", 503);
      }
      const body = z
        .object({
          data: z.object({ issue: issueLinear.nullable() }).optional(),
          errors: z.array(z.unknown()).optional(),
        })
        .parse(await boundedJson(response, 64000));
      if (body.errors?.length || !body.data?.issue)
        throw new AppError("EXTERNAL_LOOKUP_UNAVAILABLE", 503);
      if (
        body.data.issue.id !== externalId ||
        body.data.issue.team.id !== connection.destination ||
        c.teamId !== connection.destination
      )
        throw new AppError("EXTERNAL_LOOKUP_UNAVAILABLE", 503);
      return { provider: "linear" as const, body: body.data.issue, configuration: c };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("EXTERNAL_LOOKUP_UNAVAILABLE", 503);
    }
  }
  async verify(
    connection: ActionConnection,
    credential: string,
    intent: ExecutionIntent,
    externalId: string,
  ) {
    const record = await this.record(connection, credential, externalId);
    if (record.provider === "github")
      return (
        !record.body.pull_request &&
        String(record.body.number) === externalId &&
        record.body.title === intent.payload.title &&
        (record.body.body ?? "") === intent.payload.description &&
        intent.payload.dueDate === null
      );
    if (record.provider === "linear")
      return (
        record.body.id === externalId &&
        record.body.team.id === intent.destination &&
        record.body.title === intent.payload.title &&
        (record.body.description ?? "") === intent.payload.description &&
        intent.payload.dueDate === null
      );
    return (
      (record.body.key === externalId || record.body.id === externalId) &&
      record.body.fields.project.key === intent.destination &&
      record.body.fields.issuetype.id === record.configuration.issueTypeId &&
      record.body.fields.summary === intent.payload.title &&
      actionFingerprint(record.body.fields.description) ===
        actionFingerprint(adf(intent.payload.description)) &&
      (record.body.fields.duedate ?? null) === intent.payload.dueDate
    );
  }
  async status(connection: ActionConnection, credential: string, externalId: string) {
    const record = await this.record(connection, credential, externalId);
    if (record.provider === "github")
      return {
        externalId,
        state: record.body.state,
        status: record.body.state,
        updatedAt: record.body.updated_at,
      };
    if (record.provider === "linear")
      return {
        externalId,
        state: record.body.state.type,
        status: record.body.state.name,
        updatedAt: record.body.updatedAt,
      };
    return {
      externalId,
      state: record.body.fields.status.statusCategory.key,
      status: record.body.fields.status.name,
      updatedAt: record.body.fields.updated,
    };
  }
}

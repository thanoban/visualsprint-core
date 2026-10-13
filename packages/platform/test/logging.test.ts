import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import Fastify from "fastify";
import { privateHttpLogger } from "../src/logging.js";

test("HTTP logs exclude query credentials, content, headers and exception text", async () => {
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const app = Fastify({ logger: { ...privateHttpLogger, stream } });
  app.post("/callback", async (request, reply) => {
    request.log.error({ err: new Error("exception-secret") }, "controlled failure");
    reply.header("set-cookie", "response-secret");
    return { accepted: true };
  });
  await app.inject({ method: "POST", url: "/callback?code=oauth-secret", headers: {
    authorization: "Bearer token-secret", cookie: "cookie-secret",
  }, payload: { text: "transcript-secret" } });
  await app.close();
  for (const secret of ["oauth-secret", "token-secret", "cookie-secret", "response-secret", "transcript-secret", "exception-secret"])
    assert.equal(output.includes(secret), false, secret);
  assert.match(output, /"method":"POST"/);
  assert.match(output, /"statusCode":200/);
});

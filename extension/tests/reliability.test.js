import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { drainMedia } from "../lib/outbox.js";

test("every shipped JavaScript file parses (including the service worker)", () => {
  for (const directory of ["background", "offscreen", "content", "lib", "popup", "permissions"]) {
    for (const file of readdirSync(new URL(`../${directory}/`, import.meta.url))) {
      if (!file.endsWith(".js")) continue;
      const path = new URL(`../${directory}/${file}`, import.meta.url);
      const result = spawnSync(process.execPath, ["--check", path.pathname.replace(/^\/(\w:)/, "$1")]);
      assert.equal(result.status, 0, result.stderr.toString());
    }
  }
});

test("failed upload retains its entry and retries in sequence", async () => {
  const retained = new Map([2, 0, 1].map((seq) => [String(seq), { id: String(seq), seq }]));
  const acknowledged = [];
  const acknowledge = async (id) => { retained.delete(id); acknowledged.push(id); };
  await assert.rejects(drainMedia([...retained.values()], async (item) => {
    if (item.seq === 1) throw new Error("offline");
  }, acknowledge), /offline/);
  assert.deepEqual(acknowledged, ["0"]);
  assert.equal(retained.size, 2);
  await drainMedia([...retained.values()], async () => {}, acknowledge);
  assert.deepEqual(acknowledged, ["0", "1", "2"]);
  assert.equal(retained.size, 0);
});

test("stop waits for the final MediaRecorder chunk to be durably acknowledged", async () => {
  let listener;
  const events = [];
  let releaseFinal;
  const finalAck = new Promise((resolve) => { releaseFinal = resolve; });
  const tracks = [{ stop() {}, addEventListener() {} }];
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks };
  class Recorder {
    static isTypeSupported() { return true; }
    state = "inactive";
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable({ data: new Blob([new Uint8Array([1, 2, 3])]) });
      this.onstop();
    }
  }
  const context = {
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(msg) {
        events.push(msg.type);
        if (msg.type === "AUDIO_CHUNK") await finalAck;
        return { ok: true };
      } } },
    navigator: { mediaDevices: { async getUserMedia() { return stream; } } },
    AudioContext: class { state = "running"; async resume() {} async close() {}
      createMediaStreamDestination() { return { stream }; }
      createMediaStreamSource() { return { connect() {} }; }
      createGain() { return { gain: { value: 1 }, connect() {} }; }
    },
    MediaRecorder: Recorder, Blob, Uint8Array, Date, Promise,
    document: { createElement() { return { videoWidth: 0, async play() {} }; } },
    setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
  };
  vm.runInNewContext(readFileSync(new URL("../offscreen/offscreen.js", import.meta.url), "utf8"), context);
  const request = (type) => new Promise((resolve) => {
    assert.equal(listener({ target: "offscreen", type, sessionId: "session", streamId: "stream" }, {}, resolve), true);
  });
  assert.equal((await request("START_CAPTURE")).ok, true);
  let stopped = false;
  const resultPromise = request("STOP_CAPTURE").then((result) => { stopped = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.ok(events.includes("AUDIO_CHUNK"));
  releaseFinal();
  const result = await resultPromise;
  assert.equal(result.totalChunks, 1);
  assert.equal(result.ok, true);
});

test("transient auth failures preserve credentials and parallel refreshes coalesce", async () => {
  const storage = { vs_supabase_session: { expires_at: 0, refresh_token: "refresh", access_token: "old" } };
  let calls = 0;
  globalThis.chrome = { storage: { local: {
    async get(key) { return { [key]: storage[key] }; },
    async set(values) { Object.assign(storage, values); },
    async remove(keys) { for (const key of [].concat(keys)) delete storage[key]; },
  } } };
  globalThis.fetch = async () => { calls++; throw new Error("network offline"); };
  const { getAuthHeaders } = await import("../lib/auth.js");
  await assert.rejects(getAuthHeaders(), /offline/);
  assert.equal(storage.vs_supabase_session.refresh_token, "refresh");
  globalThis.fetch = async () => {
    calls++;
    await new Promise((resolve) => setImmediate(resolve));
    return { ok: true, async json() { return { access_token: "new", refresh_token: "rotated", expires_in: 3600 }; } };
  };
  const headers = await Promise.all([getAuthHeaders(), getAuthHeaders(), getAuthHeaders()]);
  assert.equal(calls, 2);
  assert.ok(headers.every((h) => h.Authorization === "Bearer new"));
  assert.equal(storage.vs_supabase_session.refresh_token, "rotated");
});

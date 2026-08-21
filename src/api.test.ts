import { test } from "node:test";
import assert from "node:assert/strict";
import { AssemblyAI, AssemblyAIError } from "./api.js";
import { trim, waitForTranscript } from "./tools.js";
import { uploadLocalFile } from "./upload.js";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fetch that answers from a script, and records what it was asked. */
function fakeFetch(
  script: Array<{ status?: number; json?: unknown; text?: string; contentType?: string }>,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    const status = step.status ?? 200;
    const ct = step.contentType ?? (step.json !== undefined ? "application/json" : "text/plain");
    const body = step.json !== undefined ? JSON.stringify(step.json) : (step.text ?? "");
    return new Response(body, { status, headers: { "content-type": ct } });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

test("the key travels in the authorization header and never in the URL", async () => {
  const { impl, calls } = fakeFetch([{ json: { id: "abc", status: "queued" } }]);
  const client = new AssemblyAI({ apiKey: "secret-key", fetchImpl: impl });
  await client.createTranscript({ audio_url: "https://example.com/a.mp3" });

  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "secret-key");
  assert.ok(!calls[0].url.includes("secret-key"), "the key must not reach the URL");
});

test("an API error surfaces the sentence the API wrote, not just the status", async () => {
  const { impl } = fakeFetch([{ status: 401, json: { error: "Authentication error, API token missing" } }]);
  const client = new AssemblyAI({ apiKey: "k", fetchImpl: impl });

  await assert.rejects(
    () => client.getTranscript("x"),
    (e: unknown) => {
      assert.ok(e instanceof AssemblyAIError);
      assert.equal(e.status, 401);
      assert.match(e.message, /API token missing/);
      return true;
    },
  );
});

test("a non-JSON body comes back as text, which is how subtitles arrive", async () => {
  const srt = "1\n00:00:00,000 --> 00:00:02,000\nhello\n";
  const { impl } = fakeFetch([{ text: srt, contentType: "application/octet-stream" }]);
  const client = new AssemblyAI({ apiKey: "k", fetchImpl: impl });
  assert.equal(await client.subtitles("id", "srt"), srt);
});

test("ids are escaped, so a hostile id cannot reshape the path", async () => {
  const { impl, calls } = fakeFetch([{ json: {} }]);
  const client = new AssemblyAI({ apiKey: "k", fetchImpl: impl });
  await client.getTranscript("../../v2/account");
  assert.ok(calls[0].url.endsWith("/v2/transcript/..%2F..%2Fv2%2Faccount"));
});

test("a trailing slash on the base URL does not produce a double slash", async () => {
  const { impl, calls } = fakeFetch([{ json: {} }]);
  const client = new AssemblyAI({ apiKey: "k", baseUrl: "https://example.com/", fetchImpl: impl });
  await client.getTranscript("id");
  assert.equal(calls[0].url, "https://example.com/v2/transcript/id");
});

test("word search sends the words joined, the way the endpoint expects", async () => {
  const { impl, calls } = fakeFetch([{ json: { total_count: 0, id: "i", matches: [] } }]);
  const client = new AssemblyAI({ apiKey: "k", fetchImpl: impl });
  await client.wordSearch("i", ["one", "two"]);
  assert.ok(calls[0].url.includes("words=one%2Ctwo"));
});

test("waiting stops as soon as the job completes", async () => {
  const { impl } = fakeFetch([
    { json: { id: "i", status: "queued" } },
    { json: { id: "i", status: "processing" } },
    { json: { id: "i", status: "completed", text: "done" } },
  ]);
  const client = new AssemblyAI({ apiKey: "k", fetchImpl: impl });
  const t = await waitForTranscript(client, "i", 60, async () => {});
  assert.equal(t.status, "completed");
  assert.equal(t.text, "done");
});

test("a failed job is returned, not thrown: the reason is the useful part", async () => {
  const { impl } = fakeFetch([{ json: { id: "i", status: "error", error: "audio file is corrupt" } }]);
  const client = new AssemblyAI({ apiKey: "k", fetchImpl: impl });
  const t = await waitForTranscript(client, "i", 60, async () => {});
  assert.equal(t.status, "error");
  assert.equal(t.error, "audio file is corrupt");
});

test("a timeout says the transcript is not lost and how to get it", async () => {
  const { impl } = fakeFetch([{ json: { id: "i", status: "processing" } }]);
  const client = new AssemblyAI({ apiKey: "k", fetchImpl: impl });
  await assert.rejects(
    () => waitForTranscript(client, "i", 0, async () => {}),
    /not lost.*get_transcript/s,
  );
});

test("trimming reports what it dropped, and leaves short text alone", () => {
  assert.deepEqual(trim("short", 100), { text: "short" });
  const t = trim("x".repeat(50), 10);
  assert.equal(t.text.length, 10);
  assert.match(t.note!, /10 of 50/);
});

test("a missing key is refused at construction, not at the first call", () => {
  assert.throws(() => new AssemblyAI({ apiKey: "" }), /API key is required/);
});

test("uploading refuses a path that is not there, and says the path", async () => {
  const { impl } = fakeFetch([{ json: {} }]);
  const client = new AssemblyAI({ apiKey: "k", fetchImpl: impl });
  await assert.rejects(
    () => uploadLocalFile(client, "/nope/missing.mp3"),
    /No file at \/nope\/missing\.mp3/,
  );
});

test("uploading refuses a file over the ceiling and names both numbers", async () => {
  const { impl } = fakeFetch([{ json: {} }]);
  const client = new AssemblyAI({ apiKey: "k", fetchImpl: impl });
  const tmp = join(tmpdir(), `aai-big-${process.pid}.bin`);
  await writeFile(tmp, Buffer.alloc(3 * 1024 * 1024));
  try {
    await assert.rejects(() => uploadLocalFile(client, tmp, 1), /3\.0 MB, over the 1 MB limit/);
  } finally {
    await rm(tmp, { force: true });
  }
});

test("uploading refuses an empty file rather than sending zero bytes", async () => {
  const { impl } = fakeFetch([{ json: {} }]);
  const client = new AssemblyAI({ apiKey: "k", fetchImpl: impl });
  const tmp = join(tmpdir(), `aai-empty-${process.pid}.bin`);
  await writeFile(tmp, "");
  try {
    await assert.rejects(() => uploadLocalFile(client, tmp), /is empty/);
  } finally {
    await rm(tmp, { force: true });
  }
});

test("a real upload returns the URL and the size it sent", async () => {
  const { impl, calls } = fakeFetch([{ json: { upload_url: "https://cdn.assemblyai.com/x" } }]);
  const client = new AssemblyAI({ apiKey: "k", fetchImpl: impl });
  const tmp = join(tmpdir(), `aai-ok-${process.pid}.bin`);
  await writeFile(tmp, Buffer.alloc(1024));
  try {
    const res = await uploadLocalFile(client, tmp);
    assert.equal(res.upload_url, "https://cdn.assemblyai.com/x");
    assert.equal(res.size_bytes, 1024);
    assert.equal(res.size_human, "1.0 KB");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/octet-stream");
  } finally {
    await rm(tmp, { force: true });
  }
});

test("a JSON body under a text/html header is still parsed", async () => {
  // 🔴 Not hypothetical. The word-search endpoint answers with a JSON object
  // and `content-type: text/html`, and trusting the header handed the caller
  // a string. `res.matches.map` then threw on a live transcript while every
  // test here passed.
  const client = new AssemblyAI({
    apiKey: "k",
    fetchImpl: async () =>
      new Response('{"total_count":1,"matches":[{"text":"a","count":1,"timestamps":[[10,20]]}]}', {
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
      }),
  });
  const res = await client.wordSearch("id", ["a"]);
  assert.equal(res.total_count, 1);
  assert.equal(res.matches[0].text, "a");
});

test("subtitles are still returned as text, not mistaken for JSON", async () => {
  const client = new AssemblyAI({
    apiKey: "k",
    fetchImpl: async () =>
      new Response("1\n00:00:00,048 --> 00:00:03,832\nSmoke from wildfires\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
  });
  const srt = await client.subtitles("id", "srt");
  assert.equal(typeof srt, "string");
  assert.match(srt, /^1\n00:00/);
});

test("the chat call goes to the gateway host and returns the message text", async () => {
  let seen = "";
  const client = new AssemblyAI({
    apiKey: "k",
    fetchImpl: async (url) => {
      seen = String(url);
      return new Response('{"choices":[{"message":{"content":"works"}}],"usage":{"total_tokens":21}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const res = await client.chat("hello");
  assert.equal(seen, "https://llm-gateway.assemblyai.com/v1/chat/completions");
  assert.equal(res.text, "works");
  assert.equal(res.tokens, 21);
});

test("the gateway reports a refused model in metadata, with status 200", async () => {
  // A 400 arrives with the errors inside the body rather than as a status the
  // caller can see, so it has to be read out or the tool returns an empty
  // answer and calls it success.
  const client = new AssemblyAI({
    apiKey: "k",
    fetchImpl: async () =>
      new Response('{"metadata":{"errors":["Your account does not have access to this LLM Gateway model"]}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(() => client.chat("hi", "some-paid-model"), /does not have access/);
});

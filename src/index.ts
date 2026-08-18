#!/usr/bin/env node
/**
 * An MCP server for the AssemblyAI API.
 *
 * Speaks stdio, so it runs wherever an MCP client can start a process. The key
 * lives in ASSEMBLYAI_API_KEY and is never written to output.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AssemblyAI } from "./api.js";
import {
  DEFAULT_TEXT_LIMIT,
  fail,
  ok,
  schemas,
  trim,
  waitForTranscript,
} from "./tools.js";

export function buildServer(client: AssemblyAI): McpServer {
  const server = new McpServer({ name: "assemblyai", version: "0.1.0" });

  server.tool(
    "transcribe",
    "Transcribe an audio or video file from a URL. Waits for the result by default.",
    schemas.transcribe,
    async (args) => {
      try {
        const { wait = true, timeout_seconds = 600, ...params } = args;
        const created = await client.createTranscript(params);
        if (!wait) {
          return ok({ id: created.id, status: created.status, hint: "Call get_transcript with this id." });
        }
        const done = await waitForTranscript(client, created.id, timeout_seconds);
        if (done.status === "error") {
          return fail(`Transcription failed: ${done.error ?? "no reason given"}`);
        }
        const { text, note } = trim(done.text ?? "", DEFAULT_TEXT_LIMIT);
        return ok({
          id: done.id,
          status: done.status,
          language_code: done.language_code,
          audio_duration_seconds: done.audio_duration,
          text,
          ...(note ? { note } : {}),
          ...(done.utterances ? { speaker_turns: done.utterances.length } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "get_transcript",
    "Fetch a transcript by id, including its status if it is still running.",
    schemas.get_transcript,
    async ({ transcript_id, max_characters = DEFAULT_TEXT_LIMIT }) => {
      try {
        const t = await client.getTranscript(transcript_id);
        if (t.status !== "completed") {
          return ok({ id: t.id, status: t.status, ...(t.error ? { error: t.error } : {}) });
        }
        const { text, note } = trim(t.text ?? "", max_characters);
        return ok({
          id: t.id,
          status: t.status,
          language_code: t.language_code,
          audio_duration_seconds: t.audio_duration,
          text,
          ...(note ? { note } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "list_transcripts",
    "List recent transcripts on the account.",
    schemas.list_transcripts,
    async ({ limit = 20, status }) => {
      try {
        const res = await client.listTranscripts({ limit, ...(status ? { status } : {}) });
        return ok(
          res.transcripts.map((t) => ({
            id: t.id,
            status: t.status,
            created: t.created,
            audio_url: t.audio_url,
          })),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "get_subtitles",
    "Get SRT or VTT subtitles for a completed transcript.",
    schemas.get_subtitles,
    async ({ transcript_id, format, chars_per_caption }) => {
      try {
        return ok(await client.subtitles(transcript_id, format, chars_per_caption));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "search_transcript",
    "Find where words are spoken in a transcript. Returns counts and timestamps.",
    schemas.search_transcript,
    async ({ transcript_id, words }) => {
      try {
        const res = await client.wordSearch(transcript_id, words);
        return ok({
          total_count: res.total_count,
          matches: res.matches.map((m) => ({
            word: m.text,
            count: m.count,
            // Milliseconds are what the API speaks; seconds are what a person reads.
            at_seconds: m.timestamps.map(([start]) => Math.round(start / 100) / 10),
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "get_speaker_turns",
    "Get who said what, for a transcript made with speaker_labels.",
    schemas.get_speaker_turns,
    async ({ transcript_id, max_turns = 100 }) => {
      try {
        const t = await client.getTranscript(transcript_id);
        if (t.status !== "completed") return ok({ id: t.id, status: t.status });
        if (!t.utterances?.length) {
          return fail(
            "This transcript has no speaker turns. Run transcribe again with speaker_labels set to true.",
          );
        }
        const turns = t.utterances.slice(0, max_turns).map((u) => ({
          speaker: u.speaker,
          at_seconds: Math.round(u.start / 100) / 10,
          text: u.text,
        }));
        return ok({
          total_turns: t.utterances.length,
          returned: turns.length,
          turns,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "ask_transcript",
    "Ask a question answered from one or more transcripts, using LeMUR.",
    schemas.ask_transcript,
    async ({ transcript_ids, question, final_model }) => {
      try {
        const res = await client.lemur("question-answer", {
          transcript_ids,
          questions: [{ question }],
          ...(final_model ? { final_model } : {}),
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "summarize_transcript",
    "Summarise one or more transcripts, using LeMUR.",
    schemas.summarize_transcript,
    async ({ transcript_ids, context, answer_format }) => {
      try {
        const res = await client.lemur("summary", {
          transcript_ids,
          ...(context ? { context } : {}),
          ...(answer_format ? { answer_format } : {}),
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

async function main() {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    console.error("ASSEMBLYAI_API_KEY is not set. Get a key at https://www.assemblyai.com/dashboard");
    process.exit(1);
  }
  const client = new AssemblyAI({ apiKey, baseUrl: process.env.ASSEMBLYAI_BASE_URL });
  await buildServer(client).connect(new StdioServerTransport());
}

// Only run when started directly, so tests can import buildServer.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

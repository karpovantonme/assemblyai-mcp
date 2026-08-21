/**
 * The tools this server exposes, defined apart from the transport so they can
 * be called directly in tests.
 *
 * Two decisions worth naming, because they are the ones an agent notices:
 *
 * 1. `transcribe` waits for the job by default. An agent that gets back a job
 *    id and a `queued` status has to invent a polling loop, and it usually
 *    invents a bad one. Waiting is what the caller meant. `wait: false` is
 *    there for the caller who really wants the id.
 *
 * 2. Transcripts are long. A tool that returns the whole thing burns the
 *    context window on text the agent will summarise anyway, so anything that
 *    can run long takes an explicit cap and says how much it trimmed.
 */

import { z } from "zod";
import { DEFAULT_LLM_MODEL } from "./api.js";
import type { AssemblyAI, Transcript } from "./api.js";

/** Characters of transcript text returned before trimming kicks in. */
export const DEFAULT_TEXT_LIMIT = 20_000;

export const schemas = {
  transcribe: {
    audio_url: z.string().url().describe("Public URL of the audio or video file to transcribe"),
    language_code: z
      .string()
      .optional()
      .describe("Language of the audio, e.g. en_us or de. Omit to let the model detect it"),
    speaker_labels: z
      .boolean()
      .optional()
      .describe("Split the transcript by speaker. Adds utterances to the result"),
    auto_chapters: z.boolean().optional().describe("Generate chapter summaries over the audio"),
    wait: z
      .boolean()
      .optional()
      .describe("Wait for the transcript to finish. Default true. Set false to get a job id back"),
    timeout_seconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("How long to wait when wait is true. Default 600"),
  },
  get_transcript: {
    transcript_id: z.string().describe("Id returned by transcribe"),
    max_characters: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Trim the text to this many characters. Default ${DEFAULT_TEXT_LIMIT}`),
  },
  list_transcripts: {
    limit: z.number().int().min(1).max(200).optional().describe("How many to return. Default 20"),
    status: z
      .enum(["queued", "processing", "completed", "error"])
      .optional()
      .describe("Only return transcripts in this status"),
  },
  get_subtitles: {
    transcript_id: z.string().describe("Id of a completed transcript"),
    format: z.enum(["srt", "vtt"]).describe("Subtitle format"),
    chars_per_caption: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum characters per caption line"),
  },
  search_transcript: {
    transcript_id: z.string().describe("Id of a completed transcript"),
    words: z.array(z.string()).min(1).describe("Words to look for. Timestamps come back per match"),
  },
  get_speaker_turns: {
    transcript_id: z.string().describe("Id of a transcript made with speaker_labels"),
    max_turns: z.number().int().positive().optional().describe("How many turns to return. Default 100"),
  },
  ask_transcript: {
    transcript_ids: z.array(z.string()).min(1).describe("Transcripts to reason over"),
    question: z.string().describe("The question to answer from those transcripts"),
    model: z
      .string()
      .optional()
      .describe(`LLM Gateway model. Default ${DEFAULT_LLM_MODEL}`),
  },
  summarize_transcript: {
    transcript_ids: z.array(z.string()).min(1).describe("Transcripts to summarise"),
    context: z.string().optional().describe("What the audio is, to steer the summary"),
    answer_format: z.string().optional().describe("Shape of the answer, e.g. bullet points"),
    model: z
      .string()
      .optional()
      .describe(`LLM Gateway model. Default ${DEFAULT_LLM_MODEL}`),
  },
};

/** Poll until the job leaves the queue, or the caller's patience runs out. */
export async function waitForTranscript(
  client: AssemblyAI,
  id: string,
  timeoutSeconds: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Transcript> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  // Start tight, back off to 5s. Short files come back in seconds and a fixed
  // long interval would make them feel slow for no reason.
  let delay = 1000;
  for (;;) {
    const t = await client.getTranscript(id);
    if (t.status === "completed" || t.status === "error") return t;
    if (Date.now() >= deadline) {
      throw new Error(
        `Transcript ${id} was still ${t.status} after ${timeoutSeconds}s. ` +
          `It is not lost: call get_transcript with this id later.`,
      );
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 5000);
  }
}

export function trim(text: string, limit: number): { text: string; note?: string } {
  if (text.length <= limit) return { text };
  return {
    text: text.slice(0, limit),
    note: `Trimmed to ${limit} of ${text.length} characters. Raise max_characters to see more.`,
  };
}

/** Everything a tool returns goes through here, so failures read the same way. */
export function ok(value: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

export function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

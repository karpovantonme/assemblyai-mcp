/**
 * A thin wrapper over the AssemblyAI REST API.
 *
 * Kept separate from the MCP layer so it can be tested without a server and
 * swapped for a fake in tests. Nothing here knows what MCP is.
 */

const DEFAULT_BASE = "https://api.assemblyai.com";

export type Fetcher = typeof fetch;

export class AssemblyAIError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "AssemblyAIError";
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: Fetcher;
}

export class AssemblyAI {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: Fetcher;

  constructor(opts: ClientOptions) {
    if (!opts.apiKey) throw new Error("An API key is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { rawBody?: ArrayBuffer | Uint8Array } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: this.apiKey,
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.body && typeof init.body === "string") {
      headers["content-type"] = "application/json";
    }

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });

    if (!res.ok) {
      let body: unknown;
      const text = await res.text().catch(() => "");
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      // The API puts the useful sentence in `error`; surfacing the raw status
      // alone sends the caller to the docs for nothing.
      const detail =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : text.slice(0, 300);
      throw new AssemblyAIError(
        detail || `Request to ${path} failed with ${res.status}`,
        res.status,
        body,
      );
    }

    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }

  /** Upload local bytes and get back a URL the transcription endpoint accepts. */
  async upload(bytes: Uint8Array): Promise<{ upload_url: string }> {
    return this.request("/v2/upload", {
      method: "POST",
      body: bytes as unknown as BodyInit,
      headers: { "content-type": "application/octet-stream" },
    });
  }

  /** Queue a transcription. Returns immediately with a job in `queued` status. */
  async createTranscript(params: Record<string, unknown>): Promise<Transcript> {
    return this.request("/v2/transcript", {
      method: "POST",
      body: JSON.stringify(params),
    });
  }

  async getTranscript(id: string): Promise<Transcript> {
    return this.request(`/v2/transcript/${encodeURIComponent(id)}`);
  }

  async listTranscripts(params: Record<string, string | number> = {}): Promise<TranscriptList> {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ).toString();
    return this.request(`/v2/transcript${qs ? `?${qs}` : ""}`);
  }

  async deleteTranscript(id: string): Promise<Transcript> {
    return this.request(`/v2/transcript/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async sentences(id: string): Promise<{ sentences: Utterance[] }> {
    return this.request(`/v2/transcript/${encodeURIComponent(id)}/sentences`);
  }

  async paragraphs(id: string): Promise<{ paragraphs: Utterance[] }> {
    return this.request(`/v2/transcript/${encodeURIComponent(id)}/paragraphs`);
  }

  /** `format` is `srt` or `vtt`. Returns the subtitle file as text. */
  async subtitles(id: string, format: "srt" | "vtt", charsPerCaption?: number): Promise<string> {
    const qs = charsPerCaption ? `?chars_per_caption=${charsPerCaption}` : "";
    return this.request(`/v2/transcript/${encodeURIComponent(id)}/${format}${qs}`);
  }

  async wordSearch(id: string, words: string[]): Promise<WordSearchResult> {
    const qs = new URLSearchParams({ words: words.join(",") }).toString();
    return this.request(`/v2/transcript/${encodeURIComponent(id)}/word-search?${qs}`);
  }

  async lemur(
    endpoint: "summary" | "question-answer" | "action-items" | "task",
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(`/lemur/v3/generate/${endpoint}`, {
      method: "POST",
      body: JSON.stringify(params),
    });
  }
}

export interface Transcript {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  text?: string | null;
  error?: string | null;
  audio_url?: string;
  audio_duration?: number | null;
  language_code?: string;
  words?: Word[] | null;
  utterances?: Utterance[] | null;
  summary?: string | null;
  [key: string]: unknown;
}

export interface Word {
  text: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: string | null;
}

export interface Utterance extends Word {
  words?: Word[];
}

export interface TranscriptList {
  transcripts: Array<Pick<Transcript, "id" | "status"> & Record<string, unknown>>;
  page_details?: Record<string, unknown>;
}

export interface WordSearchResult {
  total_count: number;
  id: string;
  matches: Array<{ text: string; count: number; timestamps: Array<[number, number]>; indexes: number[] }>;
}

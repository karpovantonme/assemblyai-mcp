# assemblyai-mcp

An MCP server for the [AssemblyAI](https://www.assemblyai.com) API. Transcription, subtitles, speaker turns, word search and LeMUR, exposed as tools an agent can call.

Written because I needed one and there wasn't one.

## Install

```bash
npm install -g assemblyai-mcp
```

Claude Code:

```bash
claude mcp add assemblyai -e ASSEMBLYAI_API_KEY=your-key -- npx -y assemblyai-mcp
```

Anything else that speaks MCP over stdio:

```json
{
  "mcpServers": {
    "assemblyai": {
      "command": "npx",
      "args": ["-y", "assemblyai-mcp"],
      "env": { "ASSEMBLYAI_API_KEY": "your-key" }
    }
  }
}
```

Keys come from [the dashboard](https://www.assemblyai.com/dashboard).

## Tools

| Tool | What it does |
|---|---|
| `upload_file` | Upload a local audio or video file and get a URL `transcribe` accepts |
| `transcribe` | Transcribe audio or video from a URL. Waits for the result by default |
| `get_transcript` | Fetch a transcript by id, with its status if it is still running |
| `list_transcripts` | Recent transcripts on the account |
| `get_subtitles` | SRT or VTT for a completed transcript |
| `search_transcript` | Where words are spoken, with counts and timestamps |
| `get_speaker_turns` | Who said what, when the transcript was made with `speaker_labels` |
| `ask_transcript` | Answer a question from one or more transcripts, through LeMUR |
| `summarize_transcript` | Summarise transcripts through LeMUR |

## Three decisions worth knowing about

**`transcribe` waits.** An agent handed a job id and a `queued` status has to invent a polling loop, and it usually invents a bad one: fixed interval, no ceiling, no message when it gives up. Waiting is what the caller meant. Pass `wait: false` if you actually want the id. On timeout the error says the transcript is not lost and names the tool that will fetch it.

**Long output is capped and says so.** Transcripts run to hundreds of kilobytes. A tool that returns all of it spends the context window on text the agent is about to summarise anyway. Anything that can run long takes a limit and reports how much it trimmed, rather than silently truncating.

**Milliseconds become seconds.** The API speaks milliseconds, which is right for an API and wrong for a model writing an answer a person will read. Timestamps come out as seconds with one decimal.

## Development

```bash
npm install
npm run build
npm test
```

The API client (`src/api.ts`) knows nothing about MCP and takes an injected `fetch`, so the tests run against a scripted transport with no network and no key. The tests cover what tends to break in a thin API wrapper: the key never reaching a URL, ids being escaped so a hostile id cannot reshape the path, non-JSON responses (subtitles arrive as text), error bodies surfacing the sentence the API wrote instead of a bare status, and the polling loop stopping on both `completed` and `error`.

## Note for AssemblyAI

If any of this is useful to you, take it. It is MIT, and it is yours to fork, rename, absorb or throw away. If you would rather have it as a first-party server, I am happy to help get it there.

MIT.

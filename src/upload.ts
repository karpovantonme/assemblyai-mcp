/**
 * Uploading a local file.
 *
 * Split out because it is the one tool that touches the filesystem, and that
 * deserves its own guard rails rather than being buried among the API calls.
 */

import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { AssemblyAI } from "./api.js";

/**
 * AssemblyAI accepts files well past this, but a server that will read any
 * path handed to it and push it over the network should have a ceiling that
 * the caller has to raise on purpose.
 */
export const DEFAULT_MAX_UPLOAD_MB = 512;

export const uploadSchema = {
  file_path: z.string().describe("Absolute path to a local audio or video file"),
  max_size_mb: z
    .number()
    .positive()
    .optional()
    .describe(`Refuse anything larger. Default ${DEFAULT_MAX_UPLOAD_MB}`),
};

export async function uploadLocalFile(
  client: AssemblyAI,
  filePath: string,
  maxSizeMb = DEFAULT_MAX_UPLOAD_MB,
): Promise<{ upload_url: string; size_bytes: number; size_human: string }> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new Error(`No file at ${filePath}. The path must be absolute and readable.`);
  }
  if (!info.isFile()) {
    throw new Error(`${filePath} is not a file.`);
  }

  const sizeMb = info.size / (1024 * 1024);
  if (sizeMb > maxSizeMb) {
    throw new Error(
      `${filePath} is ${sizeMb.toFixed(1)} MB, over the ${maxSizeMb} MB limit. ` +
        `Raise max_size_mb if that is what you meant.`,
    );
  }
  if (info.size === 0) {
    throw new Error(`${filePath} is empty.`);
  }

  const bytes = await readFile(filePath);
  const { upload_url } = await client.upload(bytes);
  // The returned URL is what the transcription endpoint wants, and it is not
  // a public link: it only works with this account's key.
  //
  // Size goes out in bytes, exact. Rounding to megabytes turned a real 1 KB
  // upload into "0.00 MB", which reads as if nothing was sent.
  return { upload_url, size_bytes: info.size, size_human: human(info.size) };
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

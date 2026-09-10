/**
 * Ringg speech-to-text ("Parrot"). A separate service from the platform API, under its own
 * base URL (RINGG_STT_BASE_URL), authenticated by the same workspace key. Transcribing
 * changes nothing in the workspace; it is billed per second of audio.
 *
 *   POST /transcriptions   multipart: file, language, enable_cap_punc
 *     -> { status, transcription, is_final, language, duration_seconds,
 *          processing_time_seconds, request_id }
 *
 * The service's limits, observed live and enforced here before anything is uploaded:
 *   - at most 10,000,000 bytes per file (413 above that);
 *   - wav, mp3, flac and m4a only (415 otherwise). It judges the format by the file name
 *     or content type, not the bytes - a WAV named "recording" is refused - so the
 *     container is sniffed here and the upload labelled to match.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { RinggClient } from "./client.js";
import { RinggShapeError } from "./errors.js";
import { isObject, type Json } from "./normalize.js";

/** The service answers 413 above this: "File too large. Max is 10000000 bytes". */
export const STT_MAX_BYTES = 10_000_000;

const DOWNLOAD_TIMEOUT_MS = 60_000;

/** The formats the service accepts, and the content type each is uploaded as. */
const ACCEPTED = { wav: "audio/wav", mp3: "audio/mpeg", flac: "audio/flac", m4a: "audio/mp4" } as const;
export type AcceptedFormat = keyof typeof ACCEPTED;

const CONVERT_HINT =
  "Convert or compress it first, e.g. `ffmpeg -i <input> -ac 1 -ar 16000 -b:a 32k out.mp3` " +
  "(mono 32 kbps MP3 fits about 40 minutes in 10 MB).";

export interface AudioInput {
  bytes: Uint8Array;
  /** Echoed in the result. A URL loses its query string: on a signed link, that is the credential. */
  origin: { file_path: string } | { audio_url: string };
}

export interface TranscribeOptions {
  language: string;
  enableCapPunc: boolean;
}

export interface TranscriptionResult {
  transcription: string;
  language?: string;
  duration_seconds?: number;
  processing_time_seconds?: number;
  request_id?: string;
  status?: string;
  is_final?: boolean;
  source: AudioInput["origin"] & { format: AcceptedFormat; bytes: number };
  note?: string;
}

/** Reads a local audio file. A leading `~/` expands; otherwise the path must be absolute. */
export async function readAudioFile(rawPath: string): Promise<AudioInput> {
  const trimmed = rawPath.trim();
  const path = trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  if (!isAbsolute(path)) {
    throw new Error(
      `file_path must be absolute - this server does not run in your working directory. Received: ${rawPath}`,
    );
  }

  const info = await stat(path).catch((err: NodeJS.ErrnoException) => {
    throw new Error(err.code === "ENOENT" ? `No file at ${path}.` : `Cannot read ${path}: ${err.message}`);
  });
  if (!info.isFile()) throw new Error(`${path} is not a file.`);
  if (info.size === 0) throw new Error(`${path} is empty.`);
  if (info.size > STT_MAX_BYTES) throw tooLarge(path, info.size);

  return { bytes: await readFile(path), origin: { file_path: path } };
}

/**
 * Downloads audio from an https URL, capped at STT_MAX_BYTES. Plain fetch, deliberately:
 * the workspace key is attached only by RinggClient and must never reach another host.
 */
export async function downloadAudio(rawUrl: string): Promise<AudioInput> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("audio_url is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error(`audio_url must use https. Received: ${url.protocol}//${url.host}`);
  }
  const shown = url.origin + url.pathname;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      const gone = res.status === 403 || res.status === 404 || res.status === 410;
      throw new Error(
        `Downloading ${shown} failed with HTTP ${res.status}.` +
          (gone ? " The link may have expired - Ringg recording URLs last 24 hours after the call." : ""),
      );
    }
    if (new URL(res.url).protocol !== "https:") {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`${shown} redirected to a non-https URL; refusing to download it.`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (declared > STT_MAX_BYTES) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge(shown, declared);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > STT_MAX_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge(shown);
        }
        chunks.push(value);
      }
    }
    if (total === 0) throw new Error(`${shown} returned no content.`);
    return { bytes: Buffer.concat(chunks, total), origin: { audio_url: shown } };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Downloading ${shown} timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s.`);
    }
    // undici reports every network failure as "fetch failed"; the cause says which.
    if (err instanceof TypeError && err.cause instanceof Error) {
      throw new Error(`Could not download ${shown}: ${err.cause.message}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** POST /transcriptions. Refuses locally anything the service would refuse. */
export async function transcribe(
  client: RinggClient,
  audio: AudioInput,
  options: TranscribeOptions,
): Promise<TranscriptionResult> {
  const where = "file_path" in audio.origin ? audio.origin.file_path : audio.origin.audio_url;
  const format = sniffAudioFormat(audio.bytes);
  if (format === undefined) {
    throw new Error(`${where} is not a recognised audio file. Ringg STT accepts WAV, MP3, FLAC and M4A.`);
  }
  if (!isAccepted(format)) {
    throw new Error(
      `${where} is ${format.toUpperCase()} audio, which Ringg STT does not accept - it takes WAV, MP3, ` +
        `FLAC and M4A. ${CONVERT_HINT}`,
    );
  }

  // The service reads the format from the name and type, so both come from the sniffed bytes.
  // The local file name stays local.
  const form = new FormData();
  form.append("file", new Blob([audio.bytes], { type: ACCEPTED[format] }), `audio.${format}`);
  form.append("language", options.language);
  form.append("enable_cap_punc", String(options.enableCapPunc));

  const res = await client.postStt("/transcriptions", form);
  if (!isObject(res) || typeof res.transcription !== "string") {
    throw new RinggShapeError(
      `Ringg STT answered without a transcription: ${JSON.stringify(res)?.slice(0, 300) ?? "empty response"}`,
    );
  }

  const text = res.transcription;
  return {
    transcription: text,
    language: str(res, "language"),
    duration_seconds: num(res, "duration_seconds"),
    processing_time_seconds: num(res, "processing_time_seconds"),
    request_id: str(res, "request_id"),
    status: str(res, "status"),
    is_final: typeof res.is_final === "boolean" ? res.is_final : undefined,
    source: { ...audio.origin, format, bytes: audio.bytes.byteLength },
    note: text.trim() === "" ? "No speech was recognised in this audio." : undefined,
  };
}

/**
 * Names an audio container from its first bytes, or returns undefined for anything that
 * is not recognisably audio - so a mistyped path is never uploaded to a remote service.
 */
export function sniffAudioFormat(bytes: Uint8Array): string | undefined {
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  const magic = text(0, 4);
  const b1 = bytes[1] ?? 0;

  if ((magic === "RIFF" || magic === "RF64" || magic === "BW64") && text(8, 12) === "WAVE") return "wav";
  if (magic === "fLaC") return "flac";
  if (text(0, 3) === "ID3") return "mp3";
  if (bytes[0] === 0xff && (b1 & 0xe0) === 0xe0) {
    // MPEG frame sync. Layer bits 00 mark ADTS AAC; 11 (Layer I) also matches a UTF-16 BOM.
    const layer = (b1 >> 1) & 0x03;
    if (layer === 0) return "aac";
    if (layer !== 3) return "mp3";
  }
  if (text(4, 8) === "ftyp") {
    // ISO media covers M4A and MP4, but also HEIC and AVIF still images.
    return /^(hei[cmsx]|hev[cmsx]|mif1|msf1|avi[fs])$/.test(text(8, 12)) ? undefined : "m4a";
  }
  if (magic === "OggS") return "ogg";
  if (magic === "\x1a\x45\xdf\xa3") return "webm";
  if (magic === "FORM" && /^AIF[FC]$/.test(text(8, 12))) return "aiff";
  if (magic === "caff") return "caf";
  if (text(0, 5) === "#!AMR") return "amr";
  return undefined;
}

function isAccepted(format: string): format is AcceptedFormat {
  return Object.hasOwn(ACCEPTED, format);
}

function tooLarge(what: string, bytes?: number): Error {
  const size = bytes === undefined ? "over 10 MB" : `${(bytes / 1e6).toFixed(1)} MB`;
  return new Error(
    `${what} is ${size}; Ringg STT accepts at most 10 MB (10,000,000 bytes) per file - about 5 minutes ` +
      `of 16 kHz WAV. ${CONVERT_HINT} Or split it into shorter parts.`,
  );
}

function str(obj: Json, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function num(obj: Json, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" ? value : undefined;
}

import { z } from "zod";
import { downloadAudio, readAudioFile, transcribe } from "../../ringg/stt.js";
import { defineTool } from "../types.js";

export const transcribeAudioTool = defineTool({
  name: "transcribe_audio",
  title: "Transcribe audio with Ringg STT",
  description:
    "Transcribe an audio file with Ringg's Parrot speech-to-text, built for Hindi, English and " +
    "Hindi-English code-mixed speech: English words come back in Latin script, Hindi in Devanagari. " +
    "Give exactly one of file_path (a local file) or audio_url (an https link, such as a call's " +
    "recording_url from get_call). Accepts WAV, MP3, FLAC and M4A up to 10 MB - about 5 minutes of " +
    "16 kHz WAV, far longer as MP3; anything else is refused before upload, with a conversion hint. " +
    "Returns plain text with no speaker labels or timestamps, and stereo audio is mixed to mono, so " +
    "overlapping speakers blur together. For a Ringg call, get_call with view=transcript already has " +
    "the turn-by-turn transcript; use this to re-transcribe a recording independently or for audio " +
    "from elsewhere. Changes nothing in the workspace, but is billed per second of audio.",
  inputSchema: {
    file_path: z
      .string()
      .min(1)
      .optional()
      .describe("Absolute path to a local audio file. A leading '~/' is expanded."),
    audio_url: z
      .string()
      .url()
      .optional()
      .describe(
        "https URL of an audio file. Fetched without the Ringg API key. Ringg recording URLs " +
          "expire 24 hours after the call.",
      ),
    language: z
      .string()
      .trim()
      .min(2)
      .max(16)
      .default("hi")
      .describe(
        "Language hint: 'hi' (default) or 'en'. Parrot transcribes code-mixed speech either way, " +
          "so the default suits most audio.",
      ),
    enable_cap_punc: z
      .boolean()
      .default(true)
      .describe("Punctuate the transcript. Defaults to true. Output stays mostly lower case either way."),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(args, { client }) {
    if (Boolean(args.file_path) === Boolean(args.audio_url)) {
      throw new Error("Give exactly one of file_path or audio_url.");
    }
    const audio = args.file_path ? await readAudioFile(args.file_path) : await downloadAudio(args.audio_url!);
    return transcribe(client, audio, { language: args.language, enableCapPunc: args.enable_cap_punc });
  },
});

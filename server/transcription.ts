/**
 * On-device audio transcription for Voice Memos. Decodes a recording to
 * 16 kHz mono PCM with the built-in macOS `afconvert`, then runs Whisper ASR
 * locally via @huggingface/transformers (Transformers.js) — the same dependency
 * `embeddings.ts` already uses, so no new toolchain or API key is required.
 *
 * First call downloads the Whisper weights (~tens–hundreds MB depending on the
 * model) and caches them in ~/.cache/huggingface. Transcripts are cached by
 * callers (Convex) so the model runs at most once per recording.
 */

import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const AFCONVERT_BIN = "/usr/bin/afconvert";
const AFCONVERT_TIMEOUT_MS = 120_000;
const SAMPLE_RATE = 16_000;

export const WHISPER_MODEL =
  process.env.BOOP_VOICEMEMOS_WHISPER_MODEL?.trim() || "Xenova/whisper-base.en";

// Lazy singleton + in-flight dedupe, mirroring embeddings.ts getLocalExtractor.
let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

async function getTranscriber(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (transcriber) return transcriber;
  if (loading) return loading;
  const attempt = (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    console.log(`[transcription] loading local ASR model ${WHISPER_MODEL} (first run downloads weights)…`);
    const start = Date.now();
    const asr = (await pipeline("automatic-speech-recognition", WHISPER_MODEL, {
      dtype: "fp32",
    })) as AutomaticSpeechRecognitionPipeline;
    console.log(`[transcription] ASR model ready in ${Date.now() - start}ms`);
    transcriber = asr;
    return asr;
  })();
  loading = attempt;
  // If the load rejects (transient network failure mid-download), clear the
  // slot so the next call retries instead of replaying the cached rejection.
  attempt.catch(() => {
    if (loading === attempt) loading = null;
  });
  return loading;
}

// Warm the model in the background so the first user-facing transcription
// doesn't pay the load cost. Failures are logged, not thrown.
export function preloadTranscriber(): void {
  getTranscriber().catch((err) => {
    console.warn("[transcription] ASR model preload failed:", err);
  });
}

async function decodeToPcm(absPath: string): Promise<Float32Array> {
  if (process.platform !== "darwin") {
    throw new Error("Voice Memo transcription is only available on macOS.");
  }
  if (!existsSync(AFCONVERT_BIN)) {
    throw new Error("afconvert is required to transcribe Voice Memos, but /usr/bin/afconvert was not found.");
  }
  if (!existsSync(absPath)) {
    throw new Error("The recording's audio file is not available locally (it may still be in iCloud).");
  }

  const dir = await mkdtemp(join(tmpdir(), "boop-vm-"));
  const wavPath = join(dir, "audio.wav");
  try {
    // 16 kHz mono little-endian 32-bit float WAV — already in [-1, 1], the form
    // Whisper expects, so no normalization is needed downstream.
    await execFileAsync(
      AFCONVERT_BIN,
      ["-f", "WAVE", "-d", "LEF32@16000", "-c", "1", absPath, wavPath],
      { timeout: AFCONVERT_TIMEOUT_MS },
    );
    const buf = await readFile(wavPath);
    return readWavFloat32(buf);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to decode the Voice Memo audio for transcription: ${text}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// afconvert writes float PCM as WAVE_FORMAT_EXTENSIBLE and pads with JUNK/PEAK
// chunks, so the data chunk is NOT at the canonical offset 44. Walk the RIFF
// chunks to find `data`, then read it as little-endian float32 (alignment-safe
// via DataView).
function readWavFloat32(buf: Buffer): Float32Array {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Decoded audio was not a valid WAV file.");
  }
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === "data") {
      const available = Math.min(chunkSize, buf.length - dataStart);
      const count = Math.floor(available / 4);
      const view = new DataView(buf.buffer, buf.byteOffset + dataStart, count * 4);
      const out = new Float32Array(count);
      for (let i = 0; i < count; i += 1) out[i] = view.getFloat32(i * 4, true);
      return out;
    }
    // Chunks are word-aligned: skip the padding byte when the size is odd.
    offset = dataStart + chunkSize + (chunkSize & 1);
  }
  throw new Error("Decoded WAV had no data chunk.");
}

export async function transcribeAudioFile(absPath: string): Promise<string> {
  const samples = await decodeToPcm(absPath);
  if (samples.length === 0) return "";
  const asr = await getTranscriber();
  // chunk/stride let Whisper handle recordings longer than its 30s window.
  const result = (await asr(samples, {
    chunk_length_s: 30,
    stride_length_s: 5,
  })) as { text?: string } | { text?: string }[];
  const text = Array.isArray(result) ? result.map((r) => r.text ?? "").join(" ") : (result.text ?? "");
  return text.trim();
}

// Exposed for testing the WAV parser without spawning afconvert/Whisper.
export const __test = { readWavFloat32, SAMPLE_RATE };

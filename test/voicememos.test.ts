import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppleTools } from "../server/apple/tools.js";
import { clearAppleSettingsCache } from "../server/runtime-config.js";
import { __test as transcriptionTest } from "../server/transcription.js";

const { readWavFloat32 } = transcriptionTest;

const tempHome = mkdtempSync(join(tmpdir(), "boop-voicememos-test-"));
const originalHome = process.env.HOME;
const originalAppleEnabled = process.env.BOOP_APPLE_ENABLED;
const originalVoiceMemosEnabled = process.env.BOOP_APPLE_VOICEMEMOS_ENABLED;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Stub Convex's /api/query so getAppleSettings falls back to env vars.
function stubConvex(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(200, { status: "success", value: null })),
  );
}

// Build a WAV the way afconvert does: chunks in arbitrary order with padding
// before the `data` chunk, so the parser must walk chunks rather than assume
// offset 44. Uses an odd-length JUNK chunk to exercise word-alignment skipping.
function buildWav(samples: number[]): Buffer {
  const junk = Buffer.from([0x01, 0x02, 0x03]); // odd length → 1 pad byte
  const junkChunk = Buffer.concat([
    Buffer.from("JUNK", "ascii"),
    u32(junk.length),
    junk,
    Buffer.alloc(junk.length & 1), // pad to even
  ]);
  const data = Buffer.alloc(samples.length * 4);
  samples.forEach((s, i) => data.writeFloatLE(s, i * 4));
  const dataChunk = Buffer.concat([Buffer.from("data", "ascii"), u32(data.length), data]);
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), junkChunk, dataChunk]);
  return Buffer.concat([Buffer.from("RIFF", "ascii"), u32(body.length), body]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

describe("transcription WAV parser", () => {
  it("extracts float32 PCM from a chunked WAV, skipping non-data chunks", () => {
    const samples = [0.5, -0.25, 1, -1, 0];
    const out = readWavFloat32(buildWav(samples));
    expect(Array.from(out)).toEqual(samples);
  });

  it("throws on a non-WAV buffer", () => {
    expect(() => readWavFloat32(Buffer.from("not a wav file at all"))).toThrow();
  });

  it("throws when there is no data chunk", () => {
    const body = Buffer.concat([Buffer.from("WAVE", "ascii")]);
    const wav = Buffer.concat([Buffer.from("RIFF", "ascii"), u32(body.length), body]);
    expect(() => readWavFloat32(wav)).toThrow(/data chunk/i);
  });
});

describe("voice memo tools (enable gating)", () => {
  beforeEach(() => {
    process.env.HOME = tempHome;
    process.env.BOOP_APPLE_ENABLED = "true";
    delete process.env.BOOP_APPLE_VOICEMEMOS_ENABLED;
    clearAppleSettingsCache();
    stubConvex();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAppleSettingsCache();
  });

  afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAppleEnabled === undefined) delete process.env.BOOP_APPLE_ENABLED;
    else process.env.BOOP_APPLE_ENABLED = originalAppleEnabled;
    if (originalVoiceMemosEnabled === undefined) delete process.env.BOOP_APPLE_VOICEMEMOS_ENABLED;
    else process.env.BOOP_APPLE_VOICEMEMOS_ENABLED = originalVoiceMemosEnabled;
  });

  it("exposes both voice memo tools", () => {
    const names = createAppleTools().map((t) => t.name);
    expect(names).toContain("apple_list_voicememos");
    expect(names).toContain("apple_read_voicememo");
  });

  it("apple_list_voicememos returns the disabled message when the source is off", async () => {
    const tool = createAppleTools().find((t) => t.name === "apple_list_voicememos");
    const result = await tool!.handle({});
    expect(result.success).toBe(true);
    expect(result.text).toContain("Voice Memos reads are disabled");
  });

  it("apple_read_voicememo returns the disabled message when the source is off", async () => {
    const tool = createAppleTools().find((t) => t.name === "apple_read_voicememo");
    const result = await tool!.handle({ id: "any-id" });
    expect(result.success).toBe(true);
    expect(result.text).toContain("Voice Memos reads are disabled");
  });
});

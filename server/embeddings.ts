/**
 * Thin embeddings wrapper. Tries Voyage → OpenAI → local Transformers.js
 * (Xenova/bge-large-en-v1.5). All three produce 1024-dim vectors so the
 * Convex vector index stays compatible regardless of which provider runs.
 *
 * Local fallback ensures `recall()` always works — no API key required.
 * First local call downloads ~440MB and caches in ~/.cache/huggingface.
 */

import type { FeatureExtractionPipeline } from "@huggingface/transformers";

const VOYAGE_MODEL = "voyage-3";
const OPENAI_MODEL = "text-embedding-3-large";
const LOCAL_MODEL = "Xenova/bge-large-en-v1.5";
const DIMENSIONS = 1024;

// Local pipeline is loaded lazily (model download is ~440MB) and cached
// in-process. `loading` dedupes parallel callers during the first load.
let extractor: FeatureExtractionPipeline | null = null;
let loading: Promise<FeatureExtractionPipeline> | null = null;

// The transformers.js pipeline is NOT safe for concurrent inference: a wiki
// search (embed of the query) running at the same time as the sync backfill
// (embedBatch) would otherwise both call `ext(...)` on the same pipeline and
// can throw, aborting the sync. Serialize all local inference through one
// promise chain. (Provider/API embeds don't go through here.)
let localChain: Promise<unknown> = Promise.resolve();
function runLocalSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = localChain.then(fn, fn);
  localChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export type EmbeddingProvider = "voyage" | "openai" | "local";

export function activeProvider(): EmbeddingProvider {
  if (process.env.VOYAGE_API_KEY) return "voyage";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "local";
}

// Always true now — local is always available. Kept for back-compat with
// callsites that still gate on it.
export function embeddingsAvailable(): boolean {
  return true;
}

async function embedVoyage(text: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: [text],
      output_dimension: DIMENSIONS,
    }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data[0].embedding;
}

async function embedOpenAI(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: text,
      dimensions: DIMENSIONS,
    }),
  });
  if (!res.ok) throw new Error(`openai embeddings ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data[0].embedding;
}

async function getLocalExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  if (loading) return loading;
  const attempt = (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    console.log(`[embeddings] loading local model ${LOCAL_MODEL} (~440MB on first run)…`);
    const start = Date.now();
    const ext = await pipeline("feature-extraction", LOCAL_MODEL, {
      dtype: "fp32",
    });
    console.log(`[embeddings] local model ready in ${Date.now() - start}ms`);
    extractor = ext;
    return ext;
  })();
  loading = attempt;
  // If the load rejects (transient network failure during the 440MB
  // download, etc.) we MUST clear `loading` so the next call re-attempts
  // instead of replaying the cached rejection forever. Detach the cleanup
  // from the returned promise via .catch(() => {}) so callers see the
  // original rejection while the slot still resets.
  attempt.catch(() => {
    if (loading === attempt) loading = null;
  });
  return loading;
}

async function embedLocal(text: string): Promise<number[]> {
  const ext = await getLocalExtractor();
  // Serialize inference: the pipeline is not concurrency-safe.
  return runLocalSerialized(async () => {
    const out = await ext(text, { pooling: "mean", normalize: true });
    // Tensor → number[]. BGE-large outputs 1024 floats; verify shape so a
    // future model swap doesn't silently produce mis-sized vectors that the
    // Convex vector index would reject.
    const arr = Array.from(out.data as ArrayLike<number>);
    if (arr.length !== DIMENSIONS) {
      throw new Error(
        `local embedding returned ${arr.length} dims, expected ${DIMENSIONS}`,
      );
    }
    return arr;
  });
}

// Preload the local model in the background so the first user-facing
// recall() doesn't pay the ~5–15s model load. Safe to call at server
// startup — failures are logged, not thrown.
export function preloadLocalModel(): void {
  if (process.env.VOYAGE_API_KEY || process.env.OPENAI_API_KEY) return;
  getLocalExtractor().catch((err) => {
    console.warn("[embeddings] local model preload failed:", err);
  });
}

export async function embed(text: string): Promise<number[] | null> {
  try {
    if (process.env.VOYAGE_API_KEY) return await embedVoyage(text);
    if (process.env.OPENAI_API_KEY) return await embedOpenAI(text);
    return await embedLocal(text);
  } catch (err) {
    console.warn("[embeddings] failed:", err);
    return null;
  }
}

// Provider batch size. Voyage caps at 128 inputs/request; OpenAI is higher but
// 128 keeps payloads modest and works for both.
const BATCH = 128;

async function embedBatchVoyage(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      output_dimension: DIMENSIONS,
    }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

async function embedBatchOpenAI(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: texts,
      dimensions: DIMENSIONS,
    }),
  });
  if (!res.ok) throw new Error(`openai embeddings ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

/**
 * Embed many texts. Uses provider batch endpoints when a key is set (Voyage →
 * OpenAI), otherwise falls back to sequential local embeds. Returns one vector
 * per input, aligned by index; a failed item is `null` (the caller can retry
 * later via the re-embed loop). Used by the wiki sync pipeline.
 */
export async function embedBatch(texts: string[]): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const useProvider = !!(process.env.VOYAGE_API_KEY || process.env.OPENAI_API_KEY);
  if (useProvider) {
    const out: (number[] | null)[] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH);
      try {
        const vecs = process.env.VOYAGE_API_KEY
          ? await embedBatchVoyage(slice)
          : await embedBatchOpenAI(slice);
        for (const v of vecs) out.push(v.length === DIMENSIONS ? v : null);
      } catch (err) {
        console.warn("[embeddings] batch slice failed, per-item fallback:", err);
        for (const t of slice) out.push(await embed(t));
      }
    }
    return out;
  }
  // Local model: no batch endpoint, embed sequentially (still cached in-process).
  const out: (number[] | null)[] = [];
  for (const t of texts) out.push(await embed(t));
  return out;
}

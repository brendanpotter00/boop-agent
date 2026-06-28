import { mutation, query } from "./_generated/server.js";
import { v } from "convex/values";

// Look up a cached transcript by the recording's stable id. Callers compare
// audioMtime / model to decide whether the cached text is still valid.
export const get = query({
  args: { recordingId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("voiceMemoTranscripts")
      .withIndex("by_recording", (q) => q.eq("recordingId", args.recordingId))
      .unique();
    if (!row) return null;
    return { text: row.text, audioMtime: row.audioMtime, model: row.model };
  },
});

// Upsert a transcript for a recording (one row per recordingId).
export const set = mutation({
  args: {
    recordingId: v.string(),
    audioMtime: v.number(),
    text: v.string(),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("voiceMemoTranscripts")
      .withIndex("by_recording", (q) => q.eq("recordingId", args.recordingId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        audioMtime: args.audioMtime,
        text: args.text,
        model: args.model,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("voiceMemoTranscripts", {
        recordingId: args.recordingId,
        audioMtime: args.audioMtime,
        text: args.text,
        model: args.model,
        updatedAt: Date.now(),
      });
    }
  },
});

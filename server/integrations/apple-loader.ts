import { createAppleMcp, createAppleTools } from "../apple/tools.js";
import { getAppleSettings } from "../runtime-config.js";
import { registerIntegration } from "./registry.js";

export function registerAppleIntegration(): void {
  registerIntegration({
    name: "apple",
    description:
      "Read-only Apple data from the user's Mac: iMessage history, Apple Notes, Apple Reminders, and Voice Memos (with on-device transcription) via the local server, plus Apple Calendar events via the optional Apple bridge.",
    isEnabled: async () => (await getAppleSettings()).enabled,
    createServer: async () => createAppleMcp(),
    createTools: async () => createAppleTools(),
  });
  console.log("[apple] registered Apple data integration");
}

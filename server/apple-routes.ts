import express from "express";
import type { NextFunction, Request, Response } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { isLocalBrowserControlRequest } from "./browser-routes.js";
import {
  APPLE_ENABLED_KEY,
  APPLE_MESSAGES_ENABLED_KEY,
  APPLE_NOTES_ENABLED_KEY,
  clearAppleSettingsCache,
  getAppleSettings,
} from "./runtime-config.js";
import { getAppleBridgeStatus, type AppleBridgeStatus } from "./apple/client.js";
import { requestLocalNotesAccess } from "./apple/notes-local.js";

interface AppleStatusResponse {
  enabled: boolean;
  messagesEnabled: boolean;
  notesEnabled: boolean;
  bridge: AppleBridgeStatus;
}

type AppleSource = "messages" | "notes";

const execFileAsync = promisify(execFile);
const FULL_DISK_ACCESS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
const AUTOMATION_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

function requireLocalAppleControl(req: Request, res: Response, next: NextFunction): void {
  if (isLocalBrowserControlRequest(req.headers, req.socket.remoteAddress ?? "")) {
    next();
    return;
  }
  res.status(403).json({
    ok: false,
    error: "Apple data control routes are only available from localhost.",
  });
}

async function appleStatus(): Promise<AppleStatusResponse> {
  const [settings, bridge] = await Promise.all([
    getAppleSettings(),
    getAppleBridgeStatus(),
  ]);
  return {
    enabled: settings.enabled,
    messagesEnabled: settings.messagesEnabled,
    notesEnabled: settings.notesEnabled,
    bridge,
  };
}

async function setAppleEnabled(enabled: boolean): Promise<AppleStatusResponse> {
  await convex.mutation(api.settings.set, {
    key: APPLE_ENABLED_KEY,
    value: enabled ? "true" : "false",
  });
  clearAppleSettingsCache();
  return appleStatus();
}

async function setAppleSourceEnabled(
  source: AppleSource,
  enabled: boolean,
): Promise<AppleStatusResponse> {
  const key = source === "messages" ? APPLE_MESSAGES_ENABLED_KEY : APPLE_NOTES_ENABLED_KEY;
  await Promise.all([
    enabled
      ? convex.mutation(api.settings.set, {
          key: APPLE_ENABLED_KEY,
          value: "true",
        })
      : Promise.resolve(),
    convex.mutation(api.settings.set, {
      key,
      value: enabled ? "true" : "false",
    }),
  ]);
  clearAppleSettingsCache();
  return appleStatus();
}

async function openFullDiskAccessSettings(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Full Disk Access settings are only available on macOS.");
  }
  await execFileAsync("open", [FULL_DISK_ACCESS_URL], { timeout: 5_000 });
}

async function openAutomationSettings(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Automation settings are only available on macOS.");
  }
  await execFileAsync("open", [AUTOMATION_URL], { timeout: 5_000 });
}

export function createAppleRouter(): express.Router {
  const router = express.Router();
  router.use(requireLocalAppleControl);

  router.get("/status", async (_req, res) => {
    try {
      res.json(await appleStatus());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/enable", async (_req, res) => {
    try {
      res.json(await setAppleEnabled(true));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/disable", async (_req, res) => {
    try {
      res.json(await setAppleEnabled(false));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/messages/enable", async (_req, res) => {
    try {
      res.json(await setAppleSourceEnabled("messages", true));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/messages/disable", async (_req, res) => {
    try {
      res.json(await setAppleSourceEnabled("messages", false));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/notes/enable", async (_req, res) => {
    try {
      res.json(await setAppleSourceEnabled("notes", true));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/notes/disable", async (_req, res) => {
    try {
      res.json(await setAppleSourceEnabled("notes", false));
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/open-full-disk-access", async (_req, res) => {
    try {
      await openFullDiskAccessSettings();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/request-notes-access", async (_req, res) => {
    try {
      await requestLocalNotesAccess();
      res.json(await appleStatus());
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/open-automation-settings", async (_req, res) => {
    try {
      await openAutomationSettings();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}

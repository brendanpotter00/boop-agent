#!/usr/bin/env node
// Registers (or re-registers) the inbound message webhook with Sendblue, so
// free-ngrok users don't have to paste into the dashboard every time their
// tunnel URL rotates.
//
// Usage:
//   node scripts/sendblue-webhook.mjs <public-webhook-url>
//   node scripts/sendblue-webhook.mjs --check [public-webhook-url]
//
// Behavior:
//   1. Uses the Sendblue API keys in .env.local to list current inbound hooks.
//   2. Removes any stale *.ngrok-free.app / *.ngrok-free.dev / *.ngrok.app / trycloudflare.com
//      webhooks of type=receive that don't match the new URL.
//   3. Adds the new URL as type=receive (unless already registered).

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const envPath = resolve(root, ".env.local");
const API_BASE = "https://api.sendblue.com";

function readEnv() {
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(?:\s+#.*)?$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function executableNames(name) {
  if (process.platform !== "win32") return [name];
  if (/\.(cmd|exe|bat)$/i.test(name)) return [name];
  return [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name];
}

function commandSearchDirs() {
  const dirs = [
    resolve(root, "node_modules", ".bin"),
    ...((process.env.PATH ?? "").split(delimiter).filter(Boolean)),
  ];
  if (process.platform === "darwin") {
    dirs.push(
      resolve(homedir(), ".local", "bin"),
      resolve(homedir(), ".npm-global", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    );
  }
  dirs.push(dirname(process.execPath));
  return [...new Set(dirs)];
}

function resolveCommand(name) {
  if (name.includes("/") || name.includes("\\")) {
    return existsSync(name) ? name : null;
  }
  for (const dir of commandSearchDirs()) {
    for (const executable of executableNames(name)) {
      const candidate = resolve(dir, executable);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function commandEnv() {
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const currentPath = process.env[pathKey] ?? process.env.PATH ?? "";
  return {
    ...process.env,
    [pathKey]: [...commandSearchDirs(), currentPath].filter(Boolean).join(delimiter),
  };
}

function spawnableNodeCommand() {
  const candidates = [
    process.env.BOOP_NODE_CMD,
    resolveCommand("node"),
    ...(process.platform === "darwin" ? ["/opt/homebrew/bin/node", "/usr/local/bin/node"] : []),
    "node",
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === "node" || existsSync(candidate)) ?? "node";
}

function nodeScriptCommand(scriptPath, leading) {
  const node = spawnableNodeCommand();
  if (process.platform !== "win32" && node !== "node") {
    return {
      cmd: "/bin/sh",
      leading: ["-lc", `exec "${node}" "$@"`, "boop-node", scriptPath, ...leading],
    };
  }
  return { cmd: node, leading: [scriptPath, ...leading] };
}

function npmExecCommand(packageName, binName) {
  const npm = resolveCommand("npm");
  if (npm) {
    try {
      const npmCli = realpathSync(npm);
      if (npmCli.endsWith(".js")) {
        return nodeScriptCommand(npmCli, [
          "exec",
          "--yes",
          "--package",
          packageName,
          "--",
          binName,
        ]);
      }
    } catch {
      /* fall through to spawning npm directly */
    }
    return {
      cmd: npm,
      leading: ["exec", "--yes", "--package", packageName, "--", binName],
    };
  }

  const npx = resolveCommand("npx");
  if (npx) {
    try {
      const npxCli = realpathSync(npx);
      if (npxCli.endsWith(".js")) {
        return nodeScriptCommand(npxCli, ["-y", packageName]);
      }
    } catch {
      /* fall through to spawning npx directly */
    }
    return { cmd: npx, leading: ["-y", packageName] };
  }

  return null;
}

function sendblueInvoker() {
  const sendblue = resolveCommand("sendblue");
  if (sendblue) return { cmd: sendblue, leading: [] };

  const npmExec = npmExecCommand("@sendblue/cli", "sendblue");
  if (npmExec) return npmExec;

  throw new Error("Could not find sendblue, npx, or npm on PATH.");
}

function runCapture(cmd, args) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd: root, env: commandEnv() });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", () => {});
    p.on("exit", (code) =>
      code === 0 ? ok(out) : fail(new Error(`${cmd} exited ${code}`)),
    );
    p.on("error", fail);
  });
}

function parseWebhookLines(output) {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const hooks = [];
  for (const line of clean.split(/\r?\n/)) {
    const urlMatch = line.match(/(https?:\/\/[^\s)]+)/);
    const typeMatch = line.match(
      /\b(receive|outbound|call_log|line_blocked|line_assigned|contact_created)\b/,
    );
    if (urlMatch && typeMatch) {
      hooks.push({ url: urlMatch[1], type: typeMatch[1] });
    }
  }
  return hooks;
}

const STALE_DOMAIN_RE = /(ngrok-free\.(app|dev)|ngrok\.app|trycloudflare\.com|loca\.lt)/;

function normalizeWebhookUrl(value) {
  const trimmed = value.replace(/\/$/, "");
  return trimmed.endsWith("/sendblue/webhook") ? trimmed : `${trimmed}/sendblue/webhook`;
}

async function readActiveTunnelUrl() {
  try {
    const response = await fetch("http://127.0.0.1:4040/api/tunnels", {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.tunnels?.find((t) => t.proto === "https")?.public_url ?? null;
  } catch {
    return null;
  }
}

async function expectedWebhookUrl(env, explicitUrl) {
  if (explicitUrl) return normalizeWebhookUrl(explicitUrl);

  const tunnelUrl = await readActiveTunnelUrl();
  if (tunnelUrl) return normalizeWebhookUrl(tunnelUrl);

  const publicUrl = env.PUBLIC_URL || "";
  if (publicUrl && !publicUrl.includes("localhost") && !publicUrl.includes("127.0.0.1")) {
    return normalizeWebhookUrl(publicUrl);
  }

  return null;
}

function sendblueHeaders(env, json = false) {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    "sb-api-key-id": env.SENDBLUE_API_KEY,
    "sb-api-secret-key": env.SENDBLUE_API_SECRET,
  };
}

async function sendblueJson(env, pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      ...sendblueHeaders(env, Boolean(options.body)),
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || body.message || `Sendblue API ${response.status}`);
  }
  return response.json().catch(() => ({}));
}

async function apiListWebhooks(env) {
  const raw = await sendblueJson(env, "/api/account/webhooks");
  const hooks = [];
  for (const [type, urls] of Object.entries(raw.webhooks || {})) {
    for (const hookUrl of urls) hooks.push({ url: hookUrl, type });
  }
  return hooks;
}

async function apiAddWebhook(env, url) {
  await sendblueJson(env, "/api/account/webhooks", {
    method: "POST",
    body: JSON.stringify({ webhooks: [url], type: "receive" }),
  });
}

async function apiRemoveWebhook(env, url) {
  await sendblueJson(env, "/api/account/webhooks", {
    method: "DELETE",
    body: JSON.stringify({ webhooks: [url], type: "receive" }),
  });
}

async function cliListWebhooks() {
  const { cmd, leading } = sendblueInvoker();
  const listing = await runCapture(cmd, [...leading, "webhooks", "list"]);
  return {
    current: parseWebhookLines(listing),
    source: "cli",
    cmd,
    leading,
  };
}

async function listWebhooks(env) {
  if (env.SENDBLUE_API_KEY && env.SENDBLUE_API_SECRET) {
    try {
      return {
        current: await apiListWebhooks(env),
        source: "api",
      };
    } catch (err) {
      const cli = await cliListWebhooks();
      return {
        ...cli,
        warning: `API list failed (${err.message}); used Sendblue CLI instead.`,
      };
    }
  }

  const cli = await cliListWebhooks();
  return {
    ...cli,
    warning: "SENDBLUE_API_KEY/SECRET are not set; used Sendblue CLI instead.",
  };
}

function webhookCheck(url, current, source, warning = "") {
  const receive = current.filter((wh) => wh.type === "receive");
  const currentMatches = receive.filter((wh) => wh.url === url);
  const staleReceiveWebhooks = receive
    .map((wh) => wh.url)
    .filter((hookUrl) => hookUrl !== url && STALE_DOMAIN_RE.test(hookUrl));
  const otherReceiveWebhooks = receive
    .map((wh) => wh.url)
    .filter((hookUrl) => hookUrl !== url && !STALE_DOMAIN_RE.test(hookUrl));
  const state = currentMatches.length > 0
    ? "registered"
    : staleReceiveWebhooks.length > 0
      ? "mismatch"
      : "missing";
  const detailParts = [];
  if (currentMatches.length === 0) {
    detailParts.push("active tunnel is not registered with Sendblue");
  } else if (currentMatches.length > 1) {
    detailParts.push(`active tunnel is registered ${currentMatches.length} times`);
  } else {
    detailParts.push("active tunnel is registered with Sendblue");
  }
  if (staleReceiveWebhooks.length) {
    detailParts.push(`${staleReceiveWebhooks.length} stale tunnel hook(s) still registered`);
  }
  if (warning) detailParts.push(warning);

  return {
    ok: currentMatches.length > 0,
    state,
    source,
    checkedAt: new Date().toISOString(),
    expectedWebhookUrl: url,
    registeredWebhookUrl: currentMatches[0]?.url || staleReceiveWebhooks[0] || "",
    currentRegistered: currentMatches.length > 0,
    currentCount: currentMatches.length,
    receiveWebhookCount: receive.length,
    staleReceiveWebhooks,
    otherReceiveWebhooks,
    details: detailParts.join("; "),
  };
}

function printWebhookCheck(check) {
  console.log(`[webhook] expected: ${check.expectedWebhookUrl}`);
  if (check.registeredWebhookUrl) {
    console.log(`[webhook] registered: ${check.registeredWebhookUrl}`);
  } else {
    console.log("[webhook] registered: none");
  }
  console.log(`[webhook] status: ${check.state}`);
  console.log(`[webhook] details: ${check.details}`);
}

async function syncWebhooks(url, current, removeWebhook, addWebhook) {
  let hasTarget = false;

  // 1. Remove stale ngrok/tunnel URLs so we don't accumulate zombie hooks.
  // Also collapse duplicate entries for the current ephemeral URL; two local
  // helpers can race during app restarts, and Sendblue accepts duplicate rows.
  for (const wh of current) {
    if (wh.type !== "receive") continue;
    if (wh.url === url) {
      if (!hasTarget) {
        hasTarget = true;
        continue;
      }
      try {
        await removeWebhook(wh.url);
        console.log(`[webhook] removed duplicate ${wh.url}`);
      } catch (err) {
        console.warn(`[webhook] could not remove duplicate ${wh.url}: ${err.message}`);
      }
      continue;
    }
    if (!STALE_DOMAIN_RE.test(wh.url)) continue;
    try {
      await removeWebhook(wh.url);
      console.log(`[webhook] removed stale ${wh.url}`);
    } catch (err) {
      console.warn(`[webhook] could not remove ${wh.url}: ${err.message}`);
    }
  }

  // 2. Skip if already registered.
  if (hasTarget) {
    console.log(`[webhook] already registered: ${url}`);
    return;
  }

  // 3. Register new.
  try {
    await addWebhook(url);
    console.log(`[webhook] registered ${url} (type=receive)`);
  } catch (err) {
    console.error(`[webhook] failed to register ${url}: ${err.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const json = args.includes("--json");
  const urlArg = args.find((arg) => !arg.startsWith("--"));
  const env = readEnv();
  const url = checkOnly ? await expectedWebhookUrl(env, urlArg) : urlArg;

  if (checkOnly && !url) {
    const result = {
      ok: false,
      state: "no-tunnel",
      source: "none",
      checkedAt: new Date().toISOString(),
      expectedWebhookUrl: "",
      registeredWebhookUrl: "",
      currentRegistered: false,
      currentCount: 0,
      receiveWebhookCount: 0,
      staleReceiveWebhooks: [],
      otherReceiveWebhooks: [],
      details: "No active ngrok tunnel or PUBLIC_URL was found.",
    };
    if (json) {
      console.log(JSON.stringify(result));
    } else {
      printWebhookCheck(result);
    }
    process.exit(2);
  }

  if (!url || !/^https?:\/\//.test(url)) {
    console.error("Usage: node scripts/sendblue-webhook.mjs <public-webhook-url>");
    console.error("   or: node scripts/sendblue-webhook.mjs --check [public-webhook-url]");
    process.exit(1);
  }

  const webhookUrl = normalizeWebhookUrl(url);

  if (checkOnly) {
    try {
      const { current, source, warning } = await listWebhooks(env);
      const result = webhookCheck(webhookUrl, current, source, warning);
      if (json) {
        console.log(JSON.stringify(result));
      } else {
        printWebhookCheck(result);
      }
      process.exit(result.ok ? 0 : 2);
    } catch (err) {
      const result = {
        ok: false,
        state: "error",
        source: "none",
        checkedAt: new Date().toISOString(),
        expectedWebhookUrl: webhookUrl,
        registeredWebhookUrl: "",
        currentRegistered: false,
        currentCount: 0,
        receiveWebhookCount: 0,
        staleReceiveWebhooks: [],
        otherReceiveWebhooks: [],
        details: err.message,
      };
      if (json) {
        console.log(JSON.stringify(result));
      } else {
        printWebhookCheck(result);
      }
      process.exit(1);
    }
  }

  if (env.SENDBLUE_API_KEY && env.SENDBLUE_API_SECRET) {
    try {
      const current = await apiListWebhooks(env);
      await syncWebhooks(
        webhookUrl,
        current,
        (hookUrl) => apiRemoveWebhook(env, hookUrl),
        (hookUrl) => apiAddWebhook(env, hookUrl),
      );
      return;
    } catch (err) {
      console.warn(`[webhook] API registration failed (${err.message}); falling back to Sendblue CLI.`);
    }
  } else {
    console.warn("[webhook] SENDBLUE_API_KEY/SECRET not set in .env.local; falling back to Sendblue CLI.");
  }

  let cli;
  try {
    cli = await cliListWebhooks();
  } catch (err) {
    console.error(`[webhook] couldn't list webhooks (${err.message}). Make sure you've logged in with \`npx @sendblue/cli login\`.`);
    return;
  }
  const { current, cmd, leading } = cli;
  await syncWebhooks(
    webhookUrl,
    current,
    (hookUrl) => runCapture(cmd, [...leading, "webhooks", "remove", hookUrl, "--type", "receive"]),
    (hookUrl) => runCapture(cmd, [...leading, "webhooks", "add", hookUrl, "--type", "receive"]),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
// Boot boop-agent against a self-hosted (local Docker) Convex backend, then
// hand off to dev.mjs for the server + Vite dashboard + Cloudflare tunnel.
//
// This is the everyday entry point once the one-time migration in
// LOCAL_STARTUP.md is done. Steps:
//   1. Ensure the Docker daemon is running (launch Docker Desktop on macOS).
//   2. docker compose up -d            → Convex backend + dashboard.
//   3. Wait for the backend to answer GET /version.
//   4. npx convex deploy               → push functions + schema, gen types.
//   5. spawn dev.mjs with SKIP_CONVEX_DEV=1 → server + Vite + Cloudflare tunnel.
//
// dev.mjs already owns the tunnel, webhook registration, and the ready banner,
// so this script stays a thin preamble around it.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`\x1b[36mstart-local\x1b[0m │ ${m}`);
const fail = (m) => {
  console.error(`\x1b[31mstart-local\x1b[0m │ ${m}`);
  process.exit(1);
};

// Hand-parse .env.local (same loose format the other scripts use). We can't
// rely on process.env because this script isn't launched through dotenv.
function readEnvLocal() {
  const p = resolve(root, ".env.local");
  const env = {};
  if (!existsSync(p)) return env;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*?)(?:\s+#.*)?$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const envVars = readEnvLocal();
const backendUrl = (envVars.CONVEX_SELF_HOSTED_URL || "http://127.0.0.1:3210").replace(/\/$/, "");

// --- 0. sanity: self-hosted config present ------------------------------
if (!envVars.CONVEX_SELF_HOSTED_URL || !envVars.CONVEX_SELF_HOSTED_ADMIN_KEY) {
  fail(
    "CONVEX_SELF_HOSTED_URL / CONVEX_SELF_HOSTED_ADMIN_KEY are not set in .env.local.\n" +
      "   This repo is still pointed at Convex Cloud (or the local backend was never\n" +
      "   provisioned). Do the one-time migration in LOCAL_STARTUP.md first.",
  );
}

// docker compose only auto-reads ./.env (which this repo doesn't use), so pass
// the compose-relevant knobs from .env.local through the child's environment.
// Deliberately NOT boop's PORT — the compose file uses CONVEX_BACKEND_PORT.
const composeEnv = { ...process.env };
for (const k of [
  "CONVEX_BACKEND_TAG",
  "CONVEX_DASHBOARD_TAG",
  "CONVEX_BACKEND_PORT",
  "CONVEX_SITE_PROXY_PORT",
  "CONVEX_DASHBOARD_PORT",
]) {
  if (envVars[k]) composeEnv[k] = envVars[k];
}

function dockerRunning() {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

// --- 1. Docker daemon ---------------------------------------------------
async function ensureDocker() {
  if (dockerRunning()) return;
  if (process.platform !== "darwin") {
    fail("Docker daemon isn't running. Start Docker and re-run `npm run start:local`.");
  }
  log("Docker isn't running — launching Docker Desktop…");
  spawnSync("open", ["-a", "Docker"], { stdio: "ignore" });
  const start = Date.now();
  while (!dockerRunning()) {
    if (Date.now() - start > 120_000) {
      fail("Docker didn't come up within 2 minutes. Open Docker Desktop, then re-run.");
    }
    await sleep(2000);
  }
  log("Docker is up.");
}

// --- 2. backend + dashboard --------------------------------------------
function composeUp() {
  log("Starting the Convex backend + dashboard (docker compose up -d)…");
  const r = spawnSync("docker", ["compose", "up", "-d"], {
    cwd: root,
    stdio: "inherit",
    env: composeEnv,
  });
  if (r.status !== 0) fail("`docker compose up -d` failed (see output above).");
}

// --- 3. wait for health -------------------------------------------------
async function waitHealthy() {
  log(`Waiting for the Convex backend at ${backendUrl} …`);
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    try {
      const res = await fetch(`${backendUrl}/version`);
      if (res.ok) {
        log(`Backend healthy (version ${(await res.text()).trim()}).`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  fail("Backend didn't become healthy within 90s. Check: docker compose logs backend");
}

// --- 4. deploy functions ------------------------------------------------
function deployFunctions() {
  log("Deploying Convex functions to the local backend (npx convex deploy)…");
  const r = spawnSync("npx", ["convex", "deploy", "--env-file", ".env.local"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CONVEX_SELF_HOSTED_URL: envVars.CONVEX_SELF_HOSTED_URL,
      CONVEX_SELF_HOSTED_ADMIN_KEY: envVars.CONVEX_SELF_HOSTED_ADMIN_KEY,
    },
  });
  if (r.status !== 0) fail("`convex deploy` failed (see output above).");
}

// --- 5. hand off to dev.mjs --------------------------------------------
function startApp() {
  log("Backend ready. Starting the app (server + dashboard + tunnel)…\n");
  const child = spawn("node", ["scripts/dev.mjs"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, SKIP_CONVEX_DEV: "1" },
  });
  const forward = (sig) => () => {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  };
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 0));
}

await ensureDocker();
composeUp();
await waitHealthy();
deployFunctions();
startApp();

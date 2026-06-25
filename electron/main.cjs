const { app, BrowserWindow, Menu, ipcMain, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const isMac = process.platform === "darwin";
const productName = "Boop";
const mutableRuntimeItems = [
  ".env",
  ".env.local",
  ".convex",
  "convex/_generated",
  "data",
  "node_modules",
];
const runtimeItems = [
  ".env.example",
  "assets",
  "convex",
  "debug",
  "package-lock.json",
  "package.json",
  "scripts",
  "server",
  "tsconfig.json",
];

let mainWindow;
let boopProcess;
let bootstrapProcess;
let webhookCheckTimer;
let webhookCheckSequence = 0;
let quitting = false;
let intentionalStop = false;
let starting = false;
let runtimeRoot = "";

const status = {
  state: "stopped",
  server: "stopped",
  convex: "stopped",
  dashboard: "stopped",
  tunnel: "unknown",
  webhook: "unknown",
  dashboardUrl: "http://localhost:5173",
  publicUrl: "",
  expectedWebhookUrl: "",
  registeredWebhookUrl: "",
  webhookDetails: "",
  webhookCheckedAt: "",
  convexUrl: "",
  phoneNumber: "",
  runtimeRoot: "",
  lastMessage: "",
};

function desktopDataRoot() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", productName);
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), productName);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), productName);
}

app.setName(productName);
app.setPath("userData", desktopDataRoot());

function isInsideMutablePath(relativePath) {
  return mutableRuntimeItems.some(
    (item) => relativePath === item || relativePath.startsWith(`${item}/`),
  );
}

function copyRuntimeItem(sourceRoot, targetRoot, relativePath) {
  if (isInsideMutablePath(relativePath)) return;

  const source = path.join(sourceRoot, relativePath);
  const target = path.join(targetRoot, relativePath);
  if (!fs.existsSync(source)) return;

  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRuntimeItem(sourceRoot, targetRoot, path.join(relativePath, entry));
    }
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function linkNodeModules(sourceRoot, targetRoot) {
  const source = path.join(sourceRoot, "node_modules");
  const target = path.join(targetRoot, "node_modules");
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  const type = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(source, target, type);
}

function preparePackagedRuntime() {
  const sourceRoot = app.getAppPath();
  const targetRoot = path.join(app.getPath("userData"), "runtime");
  fs.mkdirSync(targetRoot, { recursive: true });

  for (const item of runtimeItems) {
    copyRuntimeItem(sourceRoot, targetRoot, item);
  }
  linkNodeModules(sourceRoot, targetRoot);
  fs.writeFileSync(
    path.join(targetRoot, ".boop-desktop-runtime"),
    `source=${sourceRoot}${os.EOL}updated=${new Date().toISOString()}${os.EOL}`,
  );
  return targetRoot;
}

function getRuntimeRoot() {
  if (!app.isPackaged) return path.resolve(__dirname, "..");
  return preparePackagedRuntime();
}

function getIconPath() {
  const root = runtimeRoot || getRuntimeRoot();
  const candidates = [
    path.join(root, "assets", "boop-app-icon.png"),
    path.join(root, "assets", "boop.png"),
    path.join(root, "debug", "public", "appicon.png"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function createIcon(size = 256) {
  const image = nativeImage.createFromPath(getIconPath());
  return image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: size, height: size });
}

function writeNodeShim() {
  const shimDir = path.join(app.getPath("userData"), "bin");
  fs.mkdirSync(shimDir, { recursive: true });

  if (process.platform === "win32") {
    const shim = path.join(shimDir, "node.cmd");
    fs.writeFileSync(
      shim,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`,
    );
    return { dir: shimDir, cmd: shim };
  }

  const shim = path.join(shimDir, "node");
  fs.writeFileSync(
    shim,
    `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"
`,
    { mode: 0o755 },
  );
  fs.chmodSync(shim, 0o755);
  return { dir: shimDir, cmd: shim };
}

function childEnv() {
  const nodeShim = writeNodeShim();
  const binDir = path.join(runtimeRoot, "node_modules", ".bin");
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const existingPath = process.env[pathKey] || process.env.PATH || "";
  const macCliPaths =
    process.platform === "darwin"
      ? [
          path.join(os.homedir(), ".local", "bin"),
          path.join(os.homedir(), ".npm-global", "bin"),
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
          "/usr/local/bin",
          "/usr/local/sbin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
        ]
      : [];
  return {
    ...process.env,
    BOOP_DESKTOP: "1",
    BOOP_NODE_CMD: nodeShim.cmd,
    FORCE_COLOR: "0",
    [pathKey]: [nodeShim.dir, binDir, ...macCliPaths, existingPath].filter(Boolean).join(path.delimiter),
  };
}

const packageBinPaths = {
  convex: ["convex", "bin", "main.js"],
  tsx: ["tsx", "dist", "cli.mjs"],
  vite: ["vite", "bin", "vite.js"],
};

function localCommand(name) {
  const ext = process.platform === "win32" ? ".cmd" : "";
  const candidate = path.join(runtimeRoot, "node_modules", ".bin", `${name}${ext}`);
  if (fs.existsSync(candidate)) return { cmd: candidate, args: [] };
  const packageBin = packageBinPaths[name];
  if (packageBin) {
    const script = path.join(runtimeRoot, "node_modules", ...packageBin);
    if (fs.existsSync(script)) return { cmd: "node", args: [script] };
  }
  return { cmd: name, args: [] };
}

function readRuntimeEnv() {
  const env = {};
  if (!runtimeRoot) return env;

  for (const filename of [".env.local", ".env"]) {
    const file = path.join(runtimeRoot, filename);
    if (!fs.existsSync(file)) continue;

    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index === -1) continue;

      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      value = value.replace(/^['"]|['"]$/g, "");
      env[key] = value;
    }
  }

  return env;
}

function safeConnectionStatus() {
  const env = readRuntimeEnv();
  return {
    convexUrl: env.CONVEX_URL || env.VITE_CONVEX_URL || "",
    phoneNumber: env.SENDBLUE_FROM_NUMBER || "",
  };
}

function plainStatus(value) {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, " ");
}

function setStatus(partial) {
  Object.assign(status, safeConnectionStatus(), partial, { runtimeRoot });
  const ready =
    status.server === "running" &&
    status.convex === "running" &&
    status.dashboard === "running";
  if (ready && status.state !== "error" && status.state !== "setup-required") {
    status.state = "running";
  }
  updateMenus();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("boop-status", status);
  }
}

function webhookUrlFromPublicUrl(publicUrl) {
  const trimmed = (publicUrl || "").replace(/\/$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/sendblue/webhook") ? trimmed : `${trimmed}/sendblue/webhook`;
}

function applyWebhookCheck(result) {
  setStatus({
    webhook: result.state || (result.ok ? "registered" : "error"),
    expectedWebhookUrl: result.expectedWebhookUrl || status.expectedWebhookUrl,
    registeredWebhookUrl: result.registeredWebhookUrl || "",
    webhookDetails: result.details || "",
    webhookCheckedAt: result.checkedAt || new Date().toISOString(),
  });
}

function runWebhookCheck(expectedUrl, sequence = ++webhookCheckSequence) {
  if (!expectedUrl || !runtimeRoot) {
    setStatus({
      webhook: "no-tunnel",
      expectedWebhookUrl: "",
      registeredWebhookUrl: "",
      webhookDetails: "No active public URL is available for Sendblue.",
      webhookCheckedAt: new Date().toISOString(),
    });
    return Promise.resolve(status);
  }

  return new Promise((resolve) => {
    const script = path.join(runtimeRoot, "scripts", "sendblue-webhook.mjs");
    const child = spawn("node", [script, "--check", "--json", expectedUrl], {
      cwd: runtimeRoot,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (sequence !== webhookCheckSequence) return resolve(status);
      setStatus({
        webhook: "error",
        expectedWebhookUrl: expectedUrl,
        registeredWebhookUrl: "",
        webhookDetails: error.message,
        webhookCheckedAt: new Date().toISOString(),
      });
      resolve(status);
    });
    child.on("exit", () => {
      if (sequence !== webhookCheckSequence) return resolve(status);
      const jsonLine = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      if (!jsonLine) {
        setStatus({
          webhook: "error",
          expectedWebhookUrl: expectedUrl,
          registeredWebhookUrl: "",
          webhookDetails: stderr.trim() || stdout.trim() || "Sendblue webhook check did not return JSON.",
          webhookCheckedAt: new Date().toISOString(),
        });
        return resolve(status);
      }
      try {
        applyWebhookCheck(JSON.parse(jsonLine));
      } catch (error) {
        setStatus({
          webhook: "error",
          expectedWebhookUrl: expectedUrl,
          registeredWebhookUrl: "",
          webhookDetails: error instanceof Error ? error.message : String(error),
          webhookCheckedAt: new Date().toISOString(),
        });
      }
      resolve(status);
    });
  });
}

function scheduleWebhookCheck(publicUrl, delayMs = 1000) {
  const expectedUrl = webhookUrlFromPublicUrl(publicUrl);
  if (!expectedUrl) return;
  const sequence = ++webhookCheckSequence;
  clearTimeout(webhookCheckTimer);
  setStatus({
    webhook: "checking",
    expectedWebhookUrl: expectedUrl,
    registeredWebhookUrl: "",
    webhookDetails: "Checking Sendblue registration against the active tunnel.",
  });
  webhookCheckTimer = setTimeout(() => {
    runWebhookCheck(expectedUrl, sequence).catch(() => undefined);
  }, delayMs);
}

function checkSendblueWebhook() {
  const expectedUrl = status.expectedWebhookUrl || webhookUrlFromPublicUrl(status.publicUrl);
  setStatus({
    webhook: expectedUrl ? "checking" : "no-tunnel",
    expectedWebhookUrl: expectedUrl,
    registeredWebhookUrl: "",
    webhookDetails: expectedUrl
      ? "Checking Sendblue registration against the active tunnel."
      : "No active public URL is available for Sendblue.",
  });
  return runWebhookCheck(expectedUrl);
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function loadStatusPage() {
  if (!mainWindow) return;
  mainWindow.loadFile(path.join(__dirname, "status.html")).catch(() => undefined);
  showMainWindow();
}

function ensureNativeWindowButtons() {
  if (!isMac || !mainWindow) return;
  mainWindow.setWindowButtonVisibility(true);
  mainWindow.setWindowButtonPosition({ x: 18, y: 18 });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 620,
    title: "Boop",
    icon: getIconPath(),
    show: false,
    backgroundColor: "#101012",
    titleBarStyle: isMac ? "hidden" : undefined,
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isMac) {
    ensureNativeWindowButtons();
    mainWindow.on("show", ensureNativeWindowButtons);
    mainWindow.on("focus", ensureNativeWindowButtons);
    mainWindow.on("blur", ensureNativeWindowButtons);
    mainWindow.on("restore", ensureNativeWindowButtons);
  }

  mainWindow.once("ready-to-show", () => {
    ensureNativeWindowButtons();
    mainWindow.show();
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  loadStatusPage();
}

function openDashboardInWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow) {
    mainWindow.webContents.send("boop-open-dashboard", status.dashboardUrl);
  }
  showMainWindow();
}

function statusMenuTemplate() {
  const canOpenDashboard = status.dashboard === "running" && Boolean(status.dashboardUrl);
  const canStop = Boolean(boopProcess || bootstrapProcess || starting);
  return [
    { label: `Boop: ${plainStatus(status.state)}`, enabled: false },
    { type: "separator" },
    { label: `Server: ${plainStatus(status.server)}`, enabled: false },
    { label: `Convex: ${plainStatus(status.convex)}`, enabled: false },
    { label: `Dashboard: ${plainStatus(status.dashboard)}`, enabled: false },
    { label: `Tunnel: ${plainStatus(status.tunnel)}`, enabled: false },
    { label: `Sendblue Webhook: ${plainStatus(status.webhook)}`, enabled: false },
    { type: "separator" },
    {
      label: "Open Dashboard",
      enabled: canOpenDashboard,
      click: openDashboardInWindow,
    },
    { label: "Show Boop", click: loadStatusPage },
    {
      label: "Check Sendblue Webhook",
      enabled: Boolean(status.expectedWebhookUrl || status.publicUrl),
      click: checkSendblueWebhook,
    },
    { label: "Start Boop", enabled: !boopProcess && !starting, click: startBoop },
    { label: "Restart Boop", enabled: !starting, click: restartBoop },
    { label: "Stop Boop", enabled: canStop, click: stopBoop },
    { type: "separator" },
    { label: "Open Runtime Folder", click: () => shell.openPath(runtimeRoot) },
  ];
}

function updateMenus() {
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "Status",
      submenu: statusMenuTemplate(),
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function ingestLine(line) {
  const plain = stripAnsi(line).trim();
  if (!plain) return;
  if (
    intentionalStop &&
    (/^ngrok\s+│/.test(plain) || /obj=tunnels\.session|command_line/.test(plain)) &&
    /Stopping forwarder|Listener closed|failed to accept connection|accept failed|session closed/.test(
      plain,
    )
  ) {
    return;
  }

  const next = { lastMessage: plain };
  let checkWebhookForPublicUrl = "";
  if (/boop-agent server listening on :/.test(plain)) next.server = "running";
  if (/Convex functions ready/.test(plain)) next.convex = "running";

  const dashboardMatch =
    plain.match(/Local:\s+(http:\/\/\S+)/) ||
    plain.match(/Debug dashboard(?: \(click me\))?:\s+(http:\/\/\S+)/);
  if (dashboardMatch) {
    next.dashboard = "running";
    next.dashboardUrl = dashboardMatch[1].replace(/\/$/, "");
  }

  const publicMatch = plain.match(/Public URL:\s+(https?:\/\/\S+)/);
  if (publicMatch) {
    const publicUrl = publicMatch[1].replace(/\/$/, "");
    next.tunnel = "running";
    next.publicUrl = publicUrl;
    next.webhook = "checking";
    next.expectedWebhookUrl = webhookUrlFromPublicUrl(publicUrl);
    next.registeredWebhookUrl = "";
    next.webhookDetails = "Checking Sendblue registration against the active tunnel.";
    checkWebhookForPublicUrl = publicUrl;
  }

  if (/ngrok is not installed|No public tunnel configured/.test(plain)) {
    next.tunnel = "stopped";
    next.webhook = "no-tunnel";
    next.expectedWebhookUrl = "";
    next.registeredWebhookUrl = "";
    next.webhookDetails = "No public tunnel is running, so Sendblue cannot reach this app.";
  }
  if (/Convex types haven't been generated/.test(plain)) next.state = "setup-required";
  if (/A child process exited with code|fatal /.test(plain)) next.state = "error";

  setStatus(next);
  if (checkWebhookForPublicUrl) scheduleWebhookCheck(checkWebhookForPublicUrl);
}

function pipeOutput(stream) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      ingestLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  });
}

function runBootstrap(command, args) {
  return new Promise((resolve, reject) => {
    bootstrapProcess = spawn(command, args, {
      cwd: runtimeRoot,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    pipeOutput(bootstrapProcess.stdout);
    pipeOutput(bootstrapProcess.stderr);
    bootstrapProcess.on("error", (error) => {
      bootstrapProcess = undefined;
      reject(error);
    });
    bootstrapProcess.on("exit", (code) => {
      bootstrapProcess = undefined;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

async function ensureConvexGenerated() {
  const generatedApi = path.join(runtimeRoot, "convex", "_generated", "api.js");
  if (fs.existsSync(generatedApi)) return;

  const convex = localCommand("convex");
  setStatus({
    state: "starting",
    convex: "starting",
    lastMessage: "Generating Convex files in the desktop runtime folder.",
  });
  await runBootstrap(convex.cmd, [...convex.args, "dev", "--once", "--typecheck=disable"]);
}

function resetServiceStatuses(state) {
  clearTimeout(webhookCheckTimer);
  webhookCheckSequence += 1;
  setStatus({
    state,
    server: state === "stopped" ? "stopped" : "starting",
    convex: state === "stopped" ? "stopped" : "starting",
    dashboard: state === "stopped" ? "stopped" : "starting",
    tunnel: "unknown",
    webhook: "unknown",
    publicUrl: "",
    expectedWebhookUrl: "",
    registeredWebhookUrl: "",
    webhookDetails: "",
    webhookCheckedAt: "",
    lastMessage: "",
  });
}

async function startBoop() {
  if (boopProcess || starting) {
    showMainWindow();
    return;
  }

  starting = true;
  intentionalStop = false;
  resetServiceStatuses("starting");
  try {
    await ensureConvexGenerated();
  } catch (error) {
    starting = false;
    if (intentionalStop) {
      resetServiceStatuses("stopped");
      return;
    }
    setStatus({
      state: "setup-required",
      server: "stopped",
      dashboard: "stopped",
      lastMessage: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const script = path.join(runtimeRoot, "scripts", "dev.mjs");
  boopProcess = spawn("node", [script], {
    cwd: runtimeRoot,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  starting = false;

  pipeOutput(boopProcess.stdout);
  pipeOutput(boopProcess.stderr);
  boopProcess.on("error", (error) => {
    starting = false;
    boopProcess = undefined;
    setStatus({ state: "error", lastMessage: error.message });
  });
  boopProcess.on("exit", (code) => {
    starting = false;
    boopProcess = undefined;
    if (quitting || intentionalStop || status.state === "stopped") return;
    if (code === 0 || status.state === "setup-required") {
      resetServiceStatuses(status.state === "setup-required" ? "setup-required" : "stopped");
    } else {
      setStatus({
        state: "error",
        server: "stopped",
        convex: "stopped",
        dashboard: "stopped",
        lastMessage: `Boop exited with code ${code}`,
      });
    }
  });
}

function stopBoop() {
  if (bootstrapProcess) {
    intentionalStop = true;
    bootstrapProcess.kill("SIGTERM");
    bootstrapProcess = undefined;
  }
  if (!boopProcess) {
    starting = false;
    resetServiceStatuses("stopped");
    return;
  }
  const child = boopProcess;
  boopProcess = undefined;
  starting = false;
  intentionalStop = true;
  resetServiceStatuses("stopped");
  setStatus({ lastMessage: "Boop is stopped." });
  child.kill("SIGTERM");
}

function restartBoop() {
  stopBoop();
  setStatus({
    state: "starting",
    server: "starting",
    convex: "starting",
    dashboard: "starting",
    tunnel: "unknown",
    publicUrl: "",
    lastMessage: "Restarting Boop.",
  });
  setTimeout(startBoop, 700);
}

ipcMain.handle("boop:get-status", () => status);
ipcMain.handle("boop:start", async () => {
  await startBoop();
  return status;
});
ipcMain.handle("boop:stop", () => {
  stopBoop();
  return status;
});
ipcMain.handle("boop:restart", () => {
  restartBoop();
  return status;
});
ipcMain.handle("boop:check-webhook", async () => {
  await checkSendblueWebhook();
  return status;
});
ipcMain.handle("boop:open-dashboard", () => {
  if (!status.dashboardUrl) return;
  openDashboardInWindow();
  return status.dashboardUrl;
});
ipcMain.handle("boop:show-runtime-folder", () => shell.openPath(runtimeRoot));

app.whenReady().then(() => {
  runtimeRoot = getRuntimeRoot();
  Object.assign(status, safeConnectionStatus(), { runtimeRoot });
  if (isMac && app.dock) app.dock.setIcon(createIcon(256));

  createWindow();
  startBoop();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    showMainWindow();
  });
});

app.on("before-quit", () => {
  quitting = true;
  stopBoop();
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});

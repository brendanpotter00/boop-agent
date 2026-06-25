const fields = {
  message: document.getElementById("message"),
  runtimeRoot: document.getElementById("runtime-root"),
  emptyTitle: document.getElementById("empty-title"),
  openDashboard: document.getElementById("open-dashboard"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  restart: document.getElementById("restart"),
  dashboardFrame: document.getElementById("dashboard-frame"),
  dashboardEmpty: document.getElementById("dashboard-empty"),
};
let lastStatus = null;

function normalizeUrl(value) {
  return value ? value.replace(/\/$/, "") : "";
}

function dashboardOrigin() {
  try {
    const url = fields.dashboardFrame.dataset.url || lastStatus?.dashboardUrl || "";
    return url ? new URL(url).origin : "*";
  } catch {
    return "*";
  }
}

function dashboardStatus(status) {
  return {
    state: status.state,
    server: status.server,
    convex: status.convex,
    dashboard: status.dashboard,
    tunnel: status.tunnel,
    webhook: status.webhook,
    dashboardUrl: status.dashboardUrl,
    publicUrl: status.publicUrl,
    expectedWebhookUrl: status.expectedWebhookUrl,
    registeredWebhookUrl: status.registeredWebhookUrl,
    webhookDetails: status.webhookDetails,
    webhookCheckedAt: status.webhookCheckedAt,
    convexUrl: status.convexUrl,
    phoneNumber: status.phoneNumber,
  };
}

function postStatusToDashboard(status = lastStatus) {
  if (!status || !fields.dashboardFrame.contentWindow) return;
  fields.dashboardFrame.contentWindow.postMessage(
    {
      type: "boop-desktop-status",
      status: dashboardStatus(status),
    },
    dashboardOrigin(),
  );
}

function showDashboard(url) {
  const nextUrl = normalizeUrl(url);
  if (!nextUrl) return;
  if (fields.dashboardFrame.dataset.url !== nextUrl) {
    fields.dashboardFrame.src = nextUrl;
    fields.dashboardFrame.dataset.url = nextUrl;
  }
  fields.dashboardFrame.classList.add("visible");
  fields.dashboardEmpty.classList.add("hidden");
  window.setTimeout(() => postStatusToDashboard(), 100);
}

function hideDashboard() {
  fields.dashboardFrame.classList.remove("visible");
  fields.dashboardEmpty.classList.remove("hidden");
  fields.dashboardFrame.removeAttribute("src");
  fields.dashboardFrame.dataset.url = "";
}

function isStarting(status) {
  return (
    status.state === "starting" ||
    status.server === "starting" ||
    status.convex === "starting" ||
    status.dashboard === "starting"
  );
}

function isActive(status) {
  return (
    isStarting(status) ||
    status.state === "running" ||
    status.server === "running" ||
    status.convex === "running" ||
    status.dashboard === "running"
  );
}

function displayMessage(status) {
  const message = status.lastMessage || "";
  if (
    status.state === "stopped" &&
    (/^ngrok\s+│/.test(message) || /Listener closed|accept failed|session closed/.test(message))
  ) {
    return "Boop is stopped.";
  }
  return message || "Waiting for Boop.";
}

function render(status) {
  lastStatus = status;
  const starting = isStarting(status);
  const active = isActive(status);
  const dashboardReady = status.dashboard === "running" && Boolean(status.dashboardUrl);

  fields.message.textContent = displayMessage(status);
  fields.runtimeRoot.textContent = status.runtimeRoot || "";
  fields.openDashboard.disabled = !dashboardReady;
  fields.start.disabled = starting || active;
  fields.stop.disabled = !active;
  fields.restart.disabled = starting;

  fields.emptyTitle.textContent =
    status.state === "setup-required"
      ? "Setup required"
      : starting
        ? "Starting Boop"
        : status.state === "error"
          ? "Boop stopped"
          : "Boop is stopped";

  if (dashboardReady) {
    showDashboard(status.dashboardUrl);
  } else {
    hideDashboard();
  }

  postStatusToDashboard(status);
}

async function refreshStatus() {
  const status = await window.boopDesktop.getStatus();
  render(status);
}

function optimisticStatus(partial) {
  render({
    state: "stopped",
    server: "stopped",
    convex: "stopped",
    dashboard: "stopped",
    tunnel: "unknown",
    webhook: "unknown",
    dashboardUrl: "",
    publicUrl: "",
    expectedWebhookUrl: "",
    registeredWebhookUrl: "",
    webhookDetails: "",
    webhookCheckedAt: "",
    convexUrl: "",
    phoneNumber: "",
    runtimeRoot: "",
    lastMessage: "",
    ...(lastStatus || {}),
    ...partial,
  });
}

async function runControl(action, optimistic) {
  if (optimistic) optimisticStatus(optimistic);
  const status = await window.boopDesktop[action]();
  if (status) render(status);
  window.setTimeout(refreshStatus, 500);
  window.setTimeout(refreshStatus, 1500);
}

function optimisticForAction(action) {
  if (action === "stop") {
    return {
      state: "stopped",
      server: "stopped",
      convex: "stopped",
      dashboard: "stopped",
      tunnel: "stopped",
      webhook: "unknown",
      dashboardUrl: "",
      publicUrl: "",
      expectedWebhookUrl: "",
      registeredWebhookUrl: "",
      webhookDetails: "",
      webhookCheckedAt: "",
      lastMessage: "Boop is stopped.",
    };
  }

  return {
    state: "starting",
    server: "starting",
    convex: "starting",
    dashboard: "starting",
    tunnel: "unknown",
    webhook: "unknown",
    expectedWebhookUrl: "",
    registeredWebhookUrl: "",
    webhookDetails: "",
    webhookCheckedAt: "",
    lastMessage: action === "restart" ? "Restarting Boop." : "Starting Boop.",
  };
}

async function handleDashboardAction(action) {
  if (action === "status") {
    postStatusToDashboard();
    return;
  }
  if (action === "openDashboard") {
    const url = await window.boopDesktop.openDashboard();
    showDashboard(url);
    return;
  }
  if (action === "showRuntimeFolder") {
    window.boopDesktop.showRuntimeFolder();
    return;
  }
  if (action === "checkWebhook") {
    const status = await window.boopDesktop.checkWebhook();
    if (status) render(status);
    return;
  }
  if (["start", "stop", "restart"].includes(action)) {
    runControl(action, optimisticForAction(action));
  }
}

refreshStatus();
window.boopDesktop.onStatus(render);
window.boopDesktop.onOpenDashboard(showDashboard);
fields.dashboardFrame.addEventListener("load", () => postStatusToDashboard());

window.addEventListener("message", (event) => {
  if (event.source !== fields.dashboardFrame.contentWindow) return;
  const data = event.data || {};
  if (data.type === "boop-desktop-status-request") {
    postStatusToDashboard();
    return;
  }
  if (data.type === "boop-desktop-action" && typeof data.action === "string") {
    handleDashboardAction(data.action);
  }
});

document.getElementById("open-dashboard").addEventListener("click", async () => {
  const url = await window.boopDesktop.openDashboard();
  showDashboard(url);
});
document.getElementById("restart").addEventListener("click", () => {
  runControl("restart", optimisticForAction("restart"));
});
document.getElementById("start").addEventListener("click", () => {
  runControl("start", optimisticForAction("start"));
});
document.getElementById("stop").addEventListener("click", () => {
  runControl("stop", optimisticForAction("stop"));
});
const runtimeButton = document.getElementById("runtime");
if (runtimeButton) {
  runtimeButton.addEventListener("click", () => {
    window.boopDesktop.showRuntimeFolder();
  });
}

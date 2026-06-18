import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AppleIcon } from "@hugeicons/core-free-icons";
import { api } from "../../../convex/_generated/api.js";
import { panelCardClass, subtlePanelClass } from "./PanelPrimitives.js";

type PermissionState = "granted" | "denied" | "notDetermined";

interface ApplePermissions {
  messages: PermissionState;
  calendars: PermissionState;
  reminders: PermissionState;
  notes: PermissionState;
}

interface AppleBridgeStatus {
  running: boolean;
  source: "desktop-bridge" | "local-server" | "unavailable";
  port: number | null;
  version: string | null;
  permissions: ApplePermissions | null;
  error: string | null;
}

interface AppleStatus {
  enabled: boolean;
  bridge: AppleBridgeStatus;
}

const ENABLED_KEY = "apple_enabled";

const PERMISSION_CHIPS: { key: keyof ApplePermissions; label: string }[] = [
  { key: "messages", label: "iMessage" },
  { key: "calendars", label: "Calendar" },
  { key: "reminders", label: "Reminders" },
  { key: "notes", label: "Notes" },
];

export function AppleSection({ isDark }: { isDark: boolean }) {
  const [status, setStatus] = useState<AppleStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const storedEnabled = useQuery(api.settings.get, { key: ENABLED_KEY });
  const setSetting = useMutation(api.settings.set);

  const enabled =
    storedEnabled === undefined
      ? (status?.enabled ?? false)
      : storedEnabled === null
        ? false
        : storedEnabled === "true";

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/apple/status");
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus((await res.json()) as AppleStatus);
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, storedEnabled]);

  async function setAppleEnabled(nextEnabled: boolean) {
    setBusy("Enable");
    setMessage(null);
    try {
      await setSetting({ key: ENABLED_KEY, value: nextEnabled ? "true" : "false" });
      setMessage({
        tone: "ok",
        text: nextEnabled
          ? "Apple data access is enabled."
          : "Apple data access is disabled.",
      });
      await refresh();
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  const muted = isDark ? "text-zinc-400" : "text-zinc-500";
  const subtle = isDark ? "text-zinc-500" : "text-zinc-400";
  const label = isDark ? "text-zinc-50" : "text-zinc-950";
  const bridge = status?.bridge ?? null;
  const running = bridge?.running ?? false;
  const showAppleSection =
    !loaded || bridge?.source === "local-server" || bridge?.source === "desktop-bridge";

  if (!showAppleSection) return null;

  return (
    <section className={panelCardClass(isDark, "fade-in overflow-hidden")}>
      <div className="px-4 py-4 flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <span
            className={`h-10 w-10 rounded-xl inline-flex items-center justify-center shrink-0 ${
              isDark ? "bg-white/5 text-zinc-300" : "bg-zinc-100 text-zinc-700"
            }`}
          >
            <HugeiconsIcon icon={AppleIcon} size={20} strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <div className={`text-sm font-medium ${label}`}>Apple data (local Mac)</div>
            <div className={`text-xs mt-1 leading-relaxed max-w-3xl ${muted}`}>
              iMessage reads can run from the local server with Full Disk Access. Calendar,
              Reminders, and Notes use the optional Apple bridge.
            </div>
            <div className={`text-[10px] mono mt-2 ${subtle}`}>
              {storedEnabled === undefined
                ? `${ENABLED_KEY} = ...`
                : storedEnabled === null
                  ? `${ENABLED_KEY} = (default false)`
                  : `${ENABLED_KEY} = "${storedEnabled}"`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <BridgePill running={running} version={bridge?.version ?? null} isDark={isDark} />
          <SwitchButton
            checked={enabled}
            disabled={storedEnabled === undefined || busy !== null}
            label="Toggle Apple data access"
            isDark={isDark}
            onClick={() => setAppleEnabled(!enabled)}
          />
        </div>
      </div>

      <div className={`border-t px-4 py-4 ${isDark ? "border-white/10" : "border-zinc-200"}`}>
        {running ? (
          <div
            className={`rounded-2xl border px-3 py-3 ${
              isDark
                ? "border-emerald-500/25 bg-emerald-500/10"
                : "border-emerald-200 bg-emerald-50"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-2 text-xs font-medium ${
                  isDark ? "text-emerald-300" : "text-emerald-700"
                }`}
              >
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
              {bridge?.source === "local-server" ? "Local server connected" : "Apple bridge connected"}
              </span>
              {bridge?.version && (
                <span className={`text-[11px] mono ${isDark ? "text-emerald-300/80" : "text-emerald-700/80"}`}>
                  v{bridge.version}
                </span>
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {PERMISSION_CHIPS.map((chip) => (
                <PermissionChip
                  key={chip.key}
                  label={chip.label}
                  state={bridge?.permissions?.[chip.key] ?? "notDetermined"}
                  isDark={isDark}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className={subtlePanelClass(isDark, "px-3 py-3 text-xs leading-relaxed text-zinc-500")}>
            iMessage reads only work on macOS. Calendar, Reminders, and Notes require the optional Apple bridge.
            {bridge?.error && (
              <span className={`block mt-1.5 mono text-[11px] ${isDark ? "text-rose-300" : "text-rose-600"}`}>
                {bridge.error}
              </span>
            )}
          </div>
        )}
        {message && <MessageLine message={message} isDark={isDark} />}
      </div>
    </section>
  );
}

function PermissionChip({
  label,
  state,
  isDark,
}: {
  label: string;
  state: PermissionState;
  isDark: boolean;
}) {
  const tone =
    state === "granted"
      ? isDark
        ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
        : "border-emerald-200 bg-emerald-50 text-emerald-700"
      : state === "denied"
        ? isDark
          ? "border-rose-500/25 bg-rose-500/10 text-rose-300"
          : "border-rose-200 bg-rose-50 text-rose-600"
        : isDark
          ? "border-white/10 bg-white/5 text-zinc-400"
          : "border-zinc-200 bg-zinc-50 text-zinc-500";
  const dot =
    state === "granted" ? "bg-emerald-400" : state === "denied" ? "bg-rose-400" : "bg-zinc-400";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${tone}`}
      title={`${label}: ${state}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function BridgePill({
  running,
  version,
  isDark,
}: {
  running: boolean;
  version: string | null;
  isDark: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs shrink-0 ${
        running
          ? isDark
            ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
            : "border-emerald-200 bg-emerald-50 text-emerald-700"
          : isDark
            ? "border-white/10 bg-white/5 text-zinc-400"
            : "border-zinc-200 bg-zinc-50 text-zinc-500"
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${running ? "bg-emerald-400" : "bg-zinc-400"}`} />
      {running ? `Connected${version ? ` v${version}` : ""}` : "Not connected"}
    </span>
  );
}

function MessageLine({
  message,
  isDark,
}: {
  message: { tone: "ok" | "err"; text: string };
  isDark: boolean;
}) {
  return (
    <div
      className={`text-[11px] mt-3 ${
        message.tone === "ok"
          ? isDark
            ? "text-emerald-400"
            : "text-emerald-600"
          : isDark
            ? "text-rose-400"
            : "text-rose-600"
      }`}
    >
      {message.text}
    </div>
  );
}

function SwitchButton({
  checked,
  disabled,
  label,
  isDark,
  onClick,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  isDark: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      } ${
        checked
          ? "bg-emerald-500 focus:ring-emerald-500/40"
          : isDark
            ? "bg-zinc-700 focus:ring-zinc-500/40"
            : "bg-zinc-300 focus:ring-zinc-400/40"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

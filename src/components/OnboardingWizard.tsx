import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { TelegramAccounts } from "@/components/TelegramAccounts";
import { SlackWorkspaces } from "@/components/SlackWorkspaces";
import { useAppStore } from "@/store/useAppStore";
import { saveSecureConfig } from "@/lib/secureConfig";
import { tg } from "@/telegram/api";
import type { TgAccount } from "@/telegram/types";
import { cn } from "@/lib/utils";

type SourceKey = "imessage" | "telegram" | "slack";
type SourceStatus = "idle" | "working" | "permissions" | "done" | "error";
type IMessageStage = "installing" | "configuring" | null;

interface ServerCheck {
  reachable: boolean;
  canReadDb: boolean;
}

interface BbStatus {
  installed: boolean;
  hasConfig: boolean;
}

interface Progress {
  stage: string;
  pct: number | null;
}

/** A connection that is ready but not yet saved — saved on "Open inbox". */
interface PendingConnection {
  serverUrl: string;
  password: string;
  detail: string;
}

function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/**
 * Save the connection, then mark the app configured.
 *
 * The order matters: setConfig flips isConfigured, which unmounts the wizard.
 * Swallowing a keychain failure here told the user the connection was saved and
 * threw away the generated password while it was still on screen — secureConfig
 * deliberately propagates exactly these errors (locked keychain, denied trust
 * prompt), so let them reach the caller's error state.
 */
async function persistConnection(serverUrl: string, password: string, setConfig: (u: string, p: string) => void) {
  await saveSecureConfig({ serverUrl, password });
  setConfig(serverUrl, password);
}

/** "+46701234512" → "+46 70 ••• •• 12" */
function maskPhone(phone: string | null): string {
  if (!phone) return "";
  const p = phone.replace(/\s+/g, "");
  if (p.length < 7) return p;
  const plus = p.startsWith("+") ? 3 : 2;
  return `${p.slice(0, plus)} ${p.slice(plus, plus + 2)} ••• •• ${p.slice(-2)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const PERMISSIONS: Array<{ pane: string; label: string; why: string }> = [
  { pane: "fulldisk", label: "Full Disk Access", why: "read the Messages database" },
  { pane: "localnetwork", label: "Local Network", why: "let the server accept connections" },
  { pane: "accessibility", label: "Accessibility", why: "send messages" },
  { pane: "automation", label: "Automation", why: "control Messages & System Events" },
];

// --- small design-system pieces -------------------------------------------

const secondaryButton =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-cc-body font-medium shadow-[inset_0_0_0_1px_hsl(var(--border))] transition-[background-color] duration-120 hover:bg-muted disabled:pointer-events-none disabled:opacity-50";
const primaryButton =
  "inline-flex h-9 shrink-0 items-center justify-center gap-2.5 whitespace-nowrap rounded-md bg-primary px-4 text-cc-body font-medium text-primary-foreground disabled:pointer-events-none disabled:opacity-40";
const field =
  "h-8 w-full min-w-0 rounded-md bg-background px-2.5 text-cc-body shadow-[inset_0_0_0_1px_hsl(var(--border))] outline-none placeholder:text-muted-foreground focus:shadow-[inset_0_0_0_1.5px_hsl(var(--primary))]";

function StatusBox({ status }: { status: SourceStatus }) {
  if (status === "done") {
    return (
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Check className="h-[13px] w-[13px]" />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-signal shadow-[inset_0_0_0_1.5px_hsl(var(--signal))]">
        <AlertTriangle className="h-3 w-3" />
      </span>
    );
  }
  if (status === "working" || status === "permissions") {
    return (
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md shadow-[inset_0_0_0_1.5px_hsl(var(--signal))]">
        <span className="h-2 w-2 rounded-full bg-signal" />
      </span>
    );
  }
  return (
    <span className="h-[22px] w-[22px] shrink-0 rounded-md shadow-[inset_0_0_0_1.5px_hsl(var(--border))]" />
  );
}

function SourceRow({
  name,
  status,
  right,
  children,
  last = false,
}: {
  name: string;
  status: SourceStatus;
  right?: ReactNode;
  children?: ReactNode;
  last?: boolean;
}) {
  return (
    <div className={cn("px-4 py-3.5", !last && "border-b")}>
      <div className="flex items-center gap-3">
        <StatusBox status={status} />
        <span className="flex-1 whitespace-nowrap text-cc-body font-semibold">{name}</span>
        {right}
      </div>
      {children && <div className="ml-[34px] mt-3">{children}</div>}
    </div>
  );
}

function RowMeta({ children, signal = false }: { children: ReactNode; signal?: boolean }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap font-mono text-cc-meta",
        signal ? "text-signal" : "text-muted-foreground"
      )}
    >
      {children}
    </span>
  );
}

/**
 * The live install log: finished lines as "✓ …", the current one as "→ …" in
 * the foreground colour, failures as "✗ …" in signal.
 */
function LogPanel({ lines, working }: { lines: string[]; working: boolean }) {
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [lines]);
  if (lines.length === 0) return null;
  return (
    <div className="scrollbar-autohide max-h-40 overflow-y-auto rounded-md bg-background px-3 py-2.5 font-mono text-cc-meta leading-[18px] text-muted-foreground">
      {lines.map((raw, i) => {
        const failed = raw.startsWith("✗");
        const current = working && i === lines.length - 1 && !failed;
        const text = raw.replace(/^[✓→✗]\s*/, "");
        return (
          <div
            key={i}
            className={cn(
              "whitespace-pre-wrap break-words",
              failed && "text-signal",
              current && "text-foreground"
            )}
          >
            {failed ? "✗" : current ? "→" : "✓"} {text}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * First-run setup as a single checklist of sources. Every source lands in the
 * same inbox; "Open inbox" is enabled as soon as any one is connected.
 */
export function OnboardingWizard() {
  const setConfig = useAppStore((s) => s.setConfig);
  const dismissOnboarding = useAppStore((s) => s.dismissOnboarding);
  const telegramAvailable = useAppStore((s) => s.telegramAvailable);
  const telegramReloadNonce = useAppStore((s) => s.telegramReloadNonce);
  const slackConnected = useAppStore((s) => s.slackAvailable);
  const slackWorkspaceLabel = useAppStore(
    (s) => Object.entries(s.accountLabels).find(([k]) => k.startsWith("slack:"))?.[1] ?? null
  );

  const [expanded, setExpanded] = useState<SourceKey | null>(null);

  // --- iMessage ---
  const [imStatus, setImStatus] = useState<SourceStatus>("idle");
  const [imMode, setImMode] = useState<"auto" | "manual">("auto");
  const [imStage, setImStage] = useState<IMessageStage>(null);
  const [password, setPassword] = useState(generatePassword);
  const [port, setPort] = useState("1234");
  const [login, setLogin] = useState(false);
  const [busyMsg, setBusyMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<ServerCheck | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [reusedInstall, setReusedInstall] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [manualUrl, setManualUrl] = useState("");
  const [manualPwd, setManualPwd] = useState("");
  const [pending, setPending] = useState<PendingConnection | null>(null);

  // --- Telegram ---
  const [tgAccounts, setTgAccounts] = useState<TgAccount[]>([]);
  useEffect(() => {
    if (!telegramAvailable) return;
    let cancelled = false;
    tg.listAccounts()
      .then((a) => {
        if (!cancelled) setTgAccounts(a.filter((x) => x.authorized));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [telegramAvailable, telegramReloadNonce]);
  const tgDone = tgAccounts.length > 0;

  // A source that just finished connecting folds its row closed.
  useEffect(() => {
    if (tgDone) setExpanded((e) => (e === "telegram" ? null : e));
  }, [tgDone]);
  useEffect(() => {
    if (slackConnected) setExpanded((e) => (e === "slack" ? null : e));
  }, [slackConnected]);

  const tgStatus: SourceStatus = tgDone ? "done" : expanded === "telegram" ? "working" : "idle";
  const slStatus: SourceStatus = slackConnected ? "done" : expanded === "slack" ? "working" : "idle";

  const [finishError, setFinishError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);

  const rows: Array<{ key: SourceKey; status: SourceStatus }> = [
    { key: "imessage", status: imStatus },
    ...(telegramAvailable ? [{ key: "telegram" as const, status: tgStatus }] : []),
    { key: "slack", status: slStatus },
  ];
  const connected = rows.filter((r) => r.status === "done").length;
  const canFinish = connected > 0 && !finishing;

  // A fresh log channel per backend call, all appending to the same panel.
  function logChannel(): Channel<string> {
    const ch = new Channel<string>();
    ch.onmessage = (line) => setLogs((prev) => [...prev, line]);
    return ch;
  }

  const portNum = Math.max(1, Math.min(65535, parseInt(port, 10) || 1234));

  async function runAutoSetup() {
    setError(null);
    setLogs([]);
    setCheck(null);
    setImStatus("working");
    try {
      const status = await invoke<BbStatus>("bb_status");
      if (status.installed) {
        setReusedInstall(true);
        setLogs((prev) => [...prev, "Reusing the BlueBubbles server already installed."]);
      } else {
        setImStage("installing");
        setProgress({ stage: "resolving", pct: null });
        const channel = new Channel<Progress>();
        channel.onmessage = (p) => setProgress(p);
        await invoke("bb_install", { progress: channel, log: logChannel() });
      }

      setImStage("configuring");
      // Configure the server visibly rather than headless: a hidden first launch
      // can silently stall on a setup step, so its HTTP server never starts. A
      // visible window starts reliably and lets the user finish anything pending.
      await invoke("bb_configure", {
        password,
        port: portNum,
        headless: false,
        login,
        log: logChannel(),
      });

      setImStage(null);
      setImStatus("permissions");
    } catch (e) {
      setImStage(null);
      setError(String(e));
      setImStatus("error");
    }
  }

  async function verifyPermissions() {
    setError(null);
    setBusyMsg("Starting the server and checking access…");
    try {
      const result = await invoke<ServerCheck>("bb_start_and_check", {
        password,
        port: portNum,
        log: logChannel(),
      });
      setCheck(result);
      if (result.canReadDb) {
        const serverUrl = `http://localhost:${portNum}`;
        setPending({ serverUrl, password, detail: hostOf(serverUrl) });
        setImStatus("done");
        setExpanded((e) => (e === "imessage" ? null : e));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyMsg("");
    }
  }

  function saveManual() {
    const serverUrl = manualUrl.trim().replace(/\/$/, "");
    const pwd = manualPwd.trim();
    if (!serverUrl || !pwd) return;
    setError(null);
    setPending({ serverUrl, password: pwd, detail: hostOf(serverUrl) });
    setImStatus("done");
    setExpanded(null);
  }

  function openManual() {
    setImMode("manual");
    setError(null);
    if (imStatus === "error") setImStatus("idle");
    setExpanded("imessage");
  }

  // Save the iMessage connection (flips isConfigured, which unmounts the
  // wizard) — or, for a Telegram/Slack-only setup, just dismiss it.
  async function finish() {
    if (!canFinish) return;
    setFinishError(null);
    if (!pending) {
      dismissOnboarding();
      return;
    }
    setFinishing(true);
    try {
      await persistConnection(pending.serverUrl, pending.password, setConfig);
    } catch (e) {
      // Stay on this screen: the generated password is still in memory here,
      // and leaving would lose it.
      setFinishError(`Could not save your connection: ${String(e)}`);
    } finally {
      setFinishing(false);
    }
  }

  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void finishRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- iMessage row -------------------------------------------------------

  const workingLabel =
    imStage === "configuring"
      ? "configuring"
      : progress?.stage === "downloading"
        ? `installing${progress.pct != null ? ` ${Math.round(progress.pct)}%` : ""}`
        : progress?.stage === "installing"
          ? "installing"
          : progress?.stage === "resolving"
            ? "finding release"
            : "preparing";

  let imRight: ReactNode;
  let imBody: ReactNode = null;
  const imOpen = expanded === "imessage";

  if (imStatus === "done") {
    imRight = <RowMeta>{pending?.detail}</RowMeta>;
  } else if (imStatus === "working") {
    imRight = <RowMeta signal>{workingLabel}</RowMeta>;
    imBody = <LogPanel lines={logs} working />;
  } else if (imStatus === "permissions") {
    imRight = <RowMeta signal>permissions</RowMeta>;
    imBody = (
      <div className="space-y-3">
        <p className="text-cc-body text-muted-foreground">
          Open each pane and switch <span className="text-foreground">BlueBubbles</span> on. Full
          Disk Access and Local Network are required; Automation appears on its own the first
          time it sends. If macOS asks about the local network, click Allow.
          {reusedInstall && " Reused the BlueBubbles server already installed on this Mac."}
        </p>
        <div className="overflow-hidden rounded-md shadow-[inset_0_0_0_1px_hsl(var(--border))]">
          {PERMISSIONS.map((p, i) => (
            <div
              key={p.pane}
              className={cn("flex items-center gap-3 px-3 py-2", i > 0 && "border-t")}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-cc-body font-medium">{p.label}</span>
                <span className="block text-cc-meta text-muted-foreground">to {p.why}</span>
              </span>
              <button
                type="button"
                className={secondaryButton}
                onClick={() => invoke("bb_open_privacy", { pane: p.pane }).catch(() => {})}
              >
                Open
              </button>
            </div>
          ))}
        </div>
        {check && !check.canReadDb && (
          <p className="flex items-center gap-1.5 text-cc-meta text-signal">
            <AlertTriangle className="h-3.5 w-3.5" />
            {check.reachable
              ? "Server is up but can't read messages yet — check Full Disk Access."
              : "Server not reachable yet — check the permissions and try again."}
          </p>
        )}
        {error && <p className="text-cc-meta text-signal">{error}</p>}
        <div className="flex items-center gap-2">
          <button type="button" className={secondaryButton} onClick={verifyPermissions} disabled={!!busyMsg}>
            {busyMsg && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Verify
          </button>
          {busyMsg && <RowMeta>{busyMsg}</RowMeta>}
        </div>
        <LogPanel lines={logs} working={!!busyMsg} />
      </div>
    );
  } else if (imStatus === "error") {
    imRight = (
      <div className="flex items-center gap-2">
        <button type="button" className={secondaryButton} onClick={openManual}>
          Enter manually
        </button>
        <button type="button" className={secondaryButton} onClick={runAutoSetup}>
          Try again
        </button>
      </div>
    );
    imBody = (
      <div className="space-y-3">
        {error && <p className="break-words text-cc-meta text-signal">✗ {error}</p>}
        <LogPanel lines={logs} working={false} />
      </div>
    );
  } else if (imOpen && imMode === "manual") {
    imRight = (
      <button
        type="button"
        className={secondaryButton}
        onClick={() => {
          setImMode("auto");
          setExpanded(null);
        }}
      >
        Cancel
      </button>
    );
    imBody = (
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          saveManual();
        }}
      >
        <input
          className={field}
          placeholder="http://192.168.0.10:1234"
          value={manualUrl}
          onChange={(e) => setManualUrl(e.target.value)}
          aria-label="Server URL"
          autoFocus
        />
        <input
          className={field}
          type="password"
          placeholder="Password"
          value={manualPwd}
          onChange={(e) => setManualPwd(e.target.value)}
          aria-label="Server password"
        />
        <button
          type="submit"
          className={secondaryButton}
          disabled={!manualUrl.trim() || !manualPwd.trim()}
        >
          Connect
        </button>
      </form>
    );
  } else if (imOpen) {
    imRight = (
      <button type="button" className={secondaryButton} onClick={() => setExpanded(null)}>
        Cancel
      </button>
    );
    imBody = (
      <div className="space-y-2.5">
        <p className="text-cc-body text-muted-foreground">
          Installs the BlueBubbles server on this Mac and configures it. Requires this Mac to be
          signed into iMessage.
        </p>
        <div className="flex gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block font-mono text-cc-meta text-muted-foreground">password</span>
            <div className="flex gap-2">
              <input className={field} value={password} onChange={(e) => setPassword(e.target.value)} />
              <button
                type="button"
                className={cn(secondaryButton, "h-8")}
                onClick={() => setPassword(generatePassword())}
              >
                Regenerate
              </button>
            </div>
          </label>
          <label className="w-24 shrink-0">
            <span className="mb-1 block font-mono text-cc-meta text-muted-foreground">port</span>
            <input className={field} value={port} onChange={(e) => setPort(e.target.value)} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-cc-body">
          <input type="checkbox" checked={login} onChange={(e) => setLogin(e.target.checked)} />
          Start the server automatically at login
        </label>
        <button
          type="button"
          className={secondaryButton}
          onClick={runAutoSetup}
          disabled={!password || !port}
        >
          Install &amp; configure
        </button>
      </div>
    );
  } else {
    imRight = (
      <button
        type="button"
        className={secondaryButton}
        onClick={() => {
          setImMode("auto");
          setExpanded("imessage");
        }}
      >
        Connect
      </button>
    );
  }

  // --- Telegram / Slack rows ----------------------------------------------

  const tgRight =
    tgStatus === "done" ? (
      <RowMeta>{maskPhone(tgAccounts[0]?.phone ?? null) || tgAccounts[0]?.first_name}</RowMeta>
    ) : expanded === "telegram" ? (
      <button type="button" className={secondaryButton} onClick={() => setExpanded(null)}>
        Cancel
      </button>
    ) : (
      <button type="button" className={secondaryButton} onClick={() => setExpanded("telegram")}>
        Connect
      </button>
    );

  const slRight =
    slStatus === "done" ? (
      <RowMeta>{slackWorkspaceLabel ?? "connected"}</RowMeta>
    ) : expanded === "slack" ? (
      <button type="button" className={secondaryButton} onClick={() => setExpanded(null)}>
        Cancel
      </button>
    ) : (
      <button type="button" className={secondaryButton} onClick={() => setExpanded("slack")}>
        Connect workspace
      </button>
    );

  const lastKey = rows[rows.length - 1].key;

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto">
      <div className="m-auto w-full max-w-[600px] px-4 py-10">
        <div className="flex items-center justify-between whitespace-nowrap font-mono text-cc-meta text-muted-foreground">
          <span>setup</span>
          <span>
            {connected} / {rows.length} connected
          </span>
        </div>
        <div className="mt-2 h-[3px] rounded-sm bg-muted">
          <div
            className="h-full rounded-sm bg-signal transition-[width] duration-200"
            style={{ width: `${(connected / rows.length) * 100}%` }}
          />
        </div>

        <h1 className="mt-7 text-cc-h1 font-semibold">Connect your sources</h1>
        <p className="mt-1.5 text-cc-lead text-muted-foreground">
          Every source lands in the same inbox. Everything is stored in the macOS keychain.
        </p>

        <div className="mt-6 overflow-hidden rounded-[10px] bg-panel shadow-[inset_0_0_0_1px_hsl(var(--border))]">
          <SourceRow name="iMessage" status={imStatus} right={imRight} last={lastKey === "imessage"}>
            {imBody}
          </SourceRow>
          {telegramAvailable && (
            <SourceRow name="Telegram" status={tgStatus} right={tgRight} last={lastKey === "telegram"}>
              {expanded === "telegram" && tgStatus !== "done" && <TelegramAccounts />}
            </SourceRow>
          )}
          <SourceRow name="Slack" status={slStatus} right={slRight} last={lastKey === "slack"}>
            {expanded === "slack" && slStatus !== "done" && <SlackWorkspaces />}
          </SourceRow>
        </div>

        {finishError && <p className="mt-3 text-cc-meta text-signal">{finishError}</p>}

        <div className="mt-5 flex items-center justify-between gap-4">
          <span className="text-cc-body text-muted-foreground">
            Already have a server?{" "}
            <button
              type="button"
              onClick={openManual}
              className="text-foreground underline underline-offset-[3px]"
            >
              Enter manually
            </button>
          </span>
          <button type="button" className={primaryButton} onClick={() => void finish()} disabled={!canFinish}>
            {finishing && <Loader2 className="h-4 w-4 animate-spin" />}
            Open inbox
            <span className="font-mono text-cc-meta opacity-70">⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}

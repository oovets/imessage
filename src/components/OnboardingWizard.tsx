import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Loader2, ServerCog, Wand2, ArrowLeft, ExternalLink, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppStore } from "@/store/useAppStore";
import { saveSecureConfig } from "@/lib/secureConfig";
import { cn } from "@/lib/utils";

type Mode = "choose" | "auto" | "manual";
type Phase = "form" | "installing" | "configuring" | "permissions" | "done" | "error";

interface ServerCheck {
  reachable: boolean;
  canReadDb: boolean;
}

function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function persistConnection(serverUrl: string, password: string, setConfig: (u: string, p: string) => void) {
  await saveSecureConfig({ serverUrl, password }).catch(() => {});
  setConfig(serverUrl, password);
}

const PERMISSIONS: Array<{ pane: string; label: string; why: string }> = [
  { pane: "fulldisk", label: "Full Disk Access", why: "read the Messages database" },
  { pane: "accessibility", label: "Accessibility", why: "send messages" },
  { pane: "automation", label: "Automation", why: "control Messages & System Events" },
];

export function OnboardingWizard() {
  const setConfig = useAppStore((s) => s.setConfig);

  const [mode, setMode] = useState<Mode>("choose");

  // --- auto flow state ---
  const [phase, setPhase] = useState<Phase>("form");
  const [password, setPassword] = useState(generatePassword);
  const [port, setPort] = useState("1234");
  const [login, setLogin] = useState(false);
  const [busyMsg, setBusyMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<ServerCheck | null>(null);

  // --- manual flow state ---
  const [manualUrl, setManualUrl] = useState("");
  const [manualPwd, setManualPwd] = useState("");
  const [manualSaving, setManualSaving] = useState(false);

  const portNum = Math.max(1, Math.min(65535, parseInt(port, 10) || 1234));

  async function runAutoSetup() {
    setError(null);
    try {
      setPhase("installing");
      setBusyMsg("Downloading and installing the BlueBubbles server…");
      await invoke("bb_install");

      setPhase("configuring");
      setBusyMsg("Configuring the server (no setup wizard needed)…");
      await invoke("bb_configure", { password, port: portNum, headless: true, login });

      setPhase("permissions");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  async function verifyPermissions() {
    setError(null);
    setBusyMsg("Starting the server and checking access…");
    try {
      const result = await invoke<ServerCheck>("bb_start_and_check", { password, port: portNum });
      setCheck(result);
      if (result.canReadDb) {
        await persistConnection(`http://localhost:${portNum}`, password, setConfig);
        setPhase("done");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyMsg("");
    }
  }

  async function saveManual() {
    const url = manualUrl.trim().replace(/\/$/, "");
    const pwd = manualPwd.trim();
    if (!url || !pwd) return;
    setManualSaving(true);
    try {
      await persistConnection(url, pwd, setConfig);
    } finally {
      setManualSaving(false);
    }
  }

  const busy = phase === "installing" || phase === "configuring";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background p-6">
      <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-10" />
      <div className="w-full max-w-md">
        {mode !== "choose" && phase !== "done" && (
          <button
            onClick={() => { setMode("choose"); setPhase("form"); setError(null); }}
            className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back
          </button>
        )}

        {/* --- choose --- */}
        {mode === "choose" && (
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <ServerCog className="h-7 w-7" />
            </div>
            <h1 className="text-lg font-semibold">Welcome to Messages Desktop</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Messages Desktop talks to a BlueBubbles server on a Mac signed into iMessage.
            </p>
            <div className="mt-6 space-y-2">
              <button
                onClick={() => setMode("auto")}
                className="flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-accent"
              >
                <Wand2 className="h-5 w-5 shrink-0 text-primary" />
                <span>
                  <span className="block text-sm font-medium">Set it up for me</span>
                  <span className="block text-xs text-muted-foreground">
                    Install &amp; configure BlueBubbles automatically on this Mac
                  </span>
                </span>
              </button>
              <button
                onClick={() => setMode("manual")}
                className="flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-accent"
              >
                <ServerCog className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span>
                  <span className="block text-sm font-medium">I already have a server</span>
                  <span className="block text-xs text-muted-foreground">Enter your server URL and password</span>
                </span>
              </button>
            </div>
          </div>
        )}

        {/* --- auto: form --- */}
        {mode === "auto" && phase === "form" && (
          <div>
            <h2 className="text-base font-semibold">Automatic setup</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              This installs the BlueBubbles server and configures it headless. You'll grant three macOS
              privacy permissions along the way. Requires this Mac to be signed into iMessage.
            </p>
            <div className="mt-5 space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Server password</span>
                <div className="flex gap-2">
                  <Input value={password} onChange={(e) => setPassword(e.target.value)} />
                  <Button variant="secondary" onClick={() => setPassword(generatePassword())}>Regenerate</Button>
                </div>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Port</span>
                <Input value={port} onChange={(e) => setPort(e.target.value)} className="w-28" />
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={login} onChange={(e) => setLogin(e.target.checked)} />
                Start the server automatically at login
              </label>
            </div>
            <Button className="mt-6 w-full" onClick={runAutoSetup} disabled={!password || !port}>
              Install &amp; configure
            </Button>
          </div>
        )}

        {/* --- auto: working --- */}
        {mode === "auto" && busy && (
          <div className="flex flex-col items-center py-8 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="mt-4 text-sm">{busyMsg}</p>
            <p className="mt-1 text-xs text-muted-foreground">This can take a minute — don't quit the app.</p>
          </div>
        )}

        {/* --- auto: permissions --- */}
        {mode === "auto" && phase === "permissions" && (
          <div>
            <h2 className="text-base font-semibold">Grant three macOS permissions</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              macOS requires these by hand. Open each pane, enable <strong>BlueBubbles</strong>, then verify.
            </p>
            <div className="mt-4 space-y-2">
              {PERMISSIONS.map((p) => (
                <button
                  key={p.pane}
                  onClick={() => invoke("bb_open_privacy", { pane: p.pane }).catch(() => {})}
                  className="flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent"
                >
                  <span>
                    <span className="font-medium">{p.label}</span>
                    <span className="block text-xs text-muted-foreground">to {p.why}</span>
                  </span>
                  <ExternalLink className="h-4 w-4 text-muted-foreground" />
                </button>
              ))}
            </div>
            {check && !check.canReadDb && (
              <p className="mt-3 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                {check.reachable
                  ? "Server is up but can't read messages yet — check Full Disk Access."
                  : "Server not reachable yet — check the permissions and try again."}
              </p>
            )}
            {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
            <Button className="mt-5 w-full" onClick={verifyPermissions} disabled={!!busyMsg}>
              {busyMsg ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              I've granted them — verify
            </Button>
          </div>
        )}

        {/* --- auto: done --- */}
        {mode === "auto" && phase === "done" && (
          <div className="flex flex-col items-center py-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-500/15 text-green-600 dark:text-green-400">
              <Check className="h-7 w-7" />
            </div>
            <h2 className="mt-4 text-base font-semibold">You're all set</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The server is running and your connection is saved. Loading your chats…
            </p>
          </div>
        )}

        {/* --- auto: error --- */}
        {mode === "auto" && phase === "error" && (
          <div>
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <h2 className="text-base font-semibold">Setup failed</h2>
            </div>
            <p className="mt-2 break-words text-sm text-muted-foreground">{error}</p>
            <div className="mt-5 flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setMode("manual")}>
                Enter a server manually
              </Button>
              <Button className="flex-1" onClick={() => { setPhase("form"); setError(null); }}>
                Try again
              </Button>
            </div>
          </div>
        )}

        {/* --- manual --- */}
        {mode === "manual" && (
          <div>
            <h2 className="text-base font-semibold">Connect to your server</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter your BlueBubbles server URL and password.
            </p>
            <div className="mt-5 space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Server URL</span>
                <Input placeholder="http://192.168.0.10:1234" value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">Password</span>
                <Input type="password" value={manualPwd} onChange={(e) => setManualPwd(e.target.value)} />
              </label>
            </div>
            <Button
              className={cn("mt-6 w-full")}
              onClick={saveManual}
              disabled={!manualUrl.trim() || !manualPwd.trim() || manualSaving}
            >
              {manualSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Connect
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

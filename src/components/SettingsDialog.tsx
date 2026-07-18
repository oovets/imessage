import { useEffect, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { enable, disable } from "@tauri-apps/plugin-autostart";
import { listen } from "@tauri-apps/api/event";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAppStore } from "@/store/useAppStore";
import { TelegramAccounts } from "@/components/TelegramAccounts";
import { clearSecureConfig, saveSecureConfig } from "@/lib/secureConfig";
import { isTauriRuntime } from "@/lib/tauriEnv";
import { cn } from "@/lib/utils";
import {
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  THEME_TOKEN_LABELS,
  getThemeTokenValue,
  type ThemeMode,
} from "@/lib/appearance";

interface SettingsDialogProps {
  compact?: boolean;
}

function normalizeServerUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function SettingsDialog(_props: SettingsDialogProps) {
  const {
    serverUrl,
    password,
    isConfigured,
    configLoaded,
    setConfig,
    clearConfig,
    superlightMode,
    setSuperlightMode,
    launchOnLogin,
    setLaunchOnLogin,
    showTimestamps,
    setShowTimestamps,
    showAvatars,
    setShowAvatars,
    aiReply,
    setAiReplyConfig,
    linkPreviewsEnabled,
    setLinkPreviewsEnabled,
    clearLinkPreviewCache,
    appearance,
    decreaseFontScale,
    increaseFontScale,
    resetFontScale,
    setFontFamily,
    setThemeToken,
    resetThemeOverrides,
  } = useAppStore();
  const [url, setUrl] = useState(serverUrl);
  const [pwd, setPwd] = useState(password);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [tab, setTab] = useState<
    "server" | "telegram" | "general" | "appearance"
  >("server");
  const autoOpenedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setUrl(serverUrl);
    setPwd(password);
    setSettingsError(null);
  }, [open, serverUrl, password]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let unlisten: (() => void) | null = null;
    listen("app://open-settings", () => {
      setOpen(true);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!configLoaded || isConfigured || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    setOpen(true);
  }, [configLoaded, isConfigured]);

  async function handleSave() {
    setSaving(true);
    setSettingsError(null);
    try {
      const trimmedUrl = normalizeServerUrl(url);
      const trimmedPwd = pwd.trim();
      await saveSecureConfig({ serverUrl: trimmedUrl, password: trimmedPwd });
      setConfig(trimmedUrl, trimmedPwd);
      setOpen(false);
    } catch (err) {
      setSettingsError(`Could not save settings: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setSaving(true);
    setSettingsError(null);
    try {
      await clearSecureConfig();
      clearConfig();
      setUrl("");
      setPwd("");
    } catch (err) {
      setSettingsError(`Could not clear settings: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function toggleLaunchOnLogin() {
    if (!isTauriRuntime()) return;

    setSettingsError(null);
    try {
      if (launchOnLogin) {
        await disable();
        setLaunchOnLogin(false);
      } else {
        await enable();
        setLaunchOnLogin(true);
      }
    } catch (err) {
      setSettingsError(`Could not update launch preference: ${String(err)}`);
    }
  }

  function renderThemeEditor(mode: ThemeMode) {
    return (
      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <Label className="capitalize">{mode} colors</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => resetThemeOverrides(mode)}
          >
            Reset
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {THEME_TOKEN_LABELS.map(({ key, label }) => (
            <label
              key={`${mode}-${key}`}
              className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs"
            >
              <span className="truncate text-muted-foreground">{label}</span>
              <input
                type="color"
                value={getThemeTokenValue(appearance, mode, key)}
                onChange={(e) => setThemeToken(mode, key, e.target.value)}
                className="h-6 w-8 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                aria-label={`${mode} ${label}`}
              />
            </label>
          ))}
        </div>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="scrollbar-autohide max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Server connection, general preferences, and appearance.
          </DialogDescription>
        </DialogHeader>

        {/* Tab bar */}
        <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
          {(
            [
              ["server", "Server"],
              ["telegram", "Telegram"],
              ["general", "General"],
              ["appearance", "Appearance"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid gap-4 py-2">
          {tab === "telegram" && <TelegramAccounts />}
          {tab === "server" && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="server-url">Server URL</Label>
                <Input
                  id="server-url"
                  placeholder="https://your-server:1234"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="your-api-password"
                  value={pwd}
                  onChange={(e) => setPwd(e.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Credentials use local dev storage in Tauri dev and the macOS Keychain in
                release builds.
              </p>
              <p className="text-xs text-muted-foreground">
                If your server uses a self-signed certificate, visit{" "}
                <span className="font-mono">{url || "https://your-server"}</span> directly in
                the browser first and accept the certificate.
              </p>
            </>
          )}

          {tab === "general" && (
            <>
              {isTauriRuntime() && (
                <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span>Launch at login</span>
                  <input
                    type="checkbox"
                    checked={launchOnLogin}
                    onChange={toggleLaunchOnLogin}
                    className="h-4 w-4"
                  />
                </label>
              )}

              <div className="grid gap-2">
                <Label htmlFor="superlight-mode">Superlight UI</Label>
                <label
                  htmlFor="superlight-mode"
                  className="inline-flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <input
                    id="superlight-mode"
                    type="checkbox"
                    checked={superlightMode}
                    onChange={(e) => setSuperlightMode(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Show only text and separators
                </label>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="show-timestamps">Timestamps</Label>
                <label
                  htmlFor="show-timestamps"
                  className="inline-flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <input
                    id="show-timestamps"
                    type="checkbox"
                    checked={showTimestamps}
                    onChange={(e) => setShowTimestamps(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Show message timestamps
                </label>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="show-avatars">Avatars</Label>
                <label
                  htmlFor="show-avatars"
                  className="inline-flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <input
                    id="show-avatars"
                    type="checkbox"
                    checked={showAvatars}
                    onChange={(e) => setShowAvatars(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Show avatars (off = text only, no circles)
                </label>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="link-previews">Link previews</Label>
                <div className="flex items-center justify-between gap-3">
                  <label
                    htmlFor="link-previews"
                    className="inline-flex items-center gap-2 text-sm text-muted-foreground"
                  >
                    <input
                      id="link-previews"
                      type="checkbox"
                      checked={linkPreviewsEnabled}
                      onChange={(e) => setLinkPreviewsEnabled(e.target.checked)}
                      className="h-4 w-4"
                    />
                    Fetch rich previews automatically in desktop mode
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 px-2 text-xs"
                    onClick={clearLinkPreviewCache}
                  >
                    Clear cache
                  </Button>
                </div>
              </div>
              <div className="grid gap-2 rounded-md border p-3">
                <Label>AI auto-reply</Label>
                <p className="text-xs text-muted-foreground">
                  An OpenAI-compatible endpoint (vLLM, Ollama, …) answers as you in chats where
                  you enable the robot icon in the chat header. Replies are capped and cool down
                  automatically.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="grid gap-1">
                    <Label htmlFor="ai-endpoint" className="text-xs">Endpoint</Label>
                    <Input
                      id="ai-endpoint"
                      placeholder="http://gpulab:8000/v1"
                      value={aiReply.endpoint}
                      onChange={(e) => setAiReplyConfig({ endpoint: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label htmlFor="ai-model" className="text-xs">Model</Label>
                    <Input
                      id="ai-model"
                      placeholder="qwen2.5-72b-instruct"
                      value={aiReply.model}
                      onChange={(e) => setAiReplyConfig({ model: e.target.value })}
                    />
                  </div>
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="ai-key" className="text-xs">API key (optional)</Label>
                  <Input
                    id="ai-key"
                    type="password"
                    value={aiReply.apiKey}
                    onChange={(e) => setAiReplyConfig({ apiKey: e.target.value })}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="ai-prompt" className="text-xs">Persona / system prompt</Label>
                  <textarea
                    id="ai-prompt"
                    rows={3}
                    className="w-full rounded-md border bg-transparent px-3 py-2 text-sm"
                    value={aiReply.systemPrompt}
                    onChange={(e) => setAiReplyConfig({ systemPrompt: e.target.value })}
                  />
                </div>
              </div>
            </>
          )}

          {tab === "appearance" && (
            <div className="grid gap-3">
              <p className="text-xs text-muted-foreground">
                Use Cmd +, Cmd - and Cmd 0 to change font size from anywhere.
              </p>

              <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Font size</p>
                  <p className="text-xs text-muted-foreground">
                    {Math.round(appearance.fontScale * 100)}%
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 px-0"
                    onClick={decreaseFontScale}
                    disabled={appearance.fontScale <= MIN_FONT_SCALE}
                    aria-label="Decrease font size"
                  >
                    -
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 px-2"
                    onClick={resetFontScale}
                  >
                    100%
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 px-0"
                    onClick={increaseFontScale}
                    disabled={appearance.fontScale >= MAX_FONT_SCALE}
                    aria-label="Increase font size"
                  >
                    +
                  </Button>
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="font-family">Font family</Label>
                <Input
                  id="font-family"
                  value={appearance.fontFamily}
                  onChange={(e) => setFontFamily(e.target.value)}
                  placeholder="system-ui, sans-serif"
                />
              </div>

              {renderThemeEditor("light")}
              {renderThemeEditor("dark")}

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => resetThemeOverrides()}
              >
                Reset colors and font
              </Button>
            </div>
          )}

          {settingsError && <p className="text-xs text-destructive">{settingsError}</p>}
        </div>

        <div className="flex gap-2">
          <Button variant="outline" onClick={handleClear} disabled={saving} className="flex-1">
            Clear
          </Button>
          <Button onClick={handleSave} disabled={!url || !pwd || saving} className="flex-1">
            {saving ? "Saving…" : "Save & Connect"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

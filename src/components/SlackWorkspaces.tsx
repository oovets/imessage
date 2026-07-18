// Slack workspaces + tokens, embedded in the Settings dialog.
//
// Slack needs two tokens per workspace: a user or bot token (xoxp-/xoxb-) for
// the Web API, and an app-level token (xapp-) for Socket Mode, which is what
// delivers realtime messages. Both are stored in the keychain by the host.

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppStore } from "@/store/useAppStore";
import { sl } from "@/slack/api";
import type { SlWorkspace } from "@/slack/types";

export function SlackWorkspaces() {
  const reloadSlack = useAppStore((s) => s.reloadSlack);

  const [workspaces, setWorkspaces] = useState<SlWorkspace[]>([]);
  const [importedFromFile, setImportedFromFile] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const status = await sl.status();
      setWorkspaces(status.workspaces);
      setImportedFromFile(status.importedFromFile);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function guard(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {importedFromFile && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Tokens were imported from your slack_rust config into the keychain — you can delete
          that plaintext file now.
        </p>
      )}

      <div className="space-y-2">
        {workspaces.length === 0 && !adding && (
          <p className="text-sm text-muted-foreground">No Slack workspaces yet.</p>
        )}
        {workspaces.map((ws) => (
          <div key={ws.id} className="flex items-center justify-between rounded-lg border px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{ws.name}</div>
              <div className="text-xs text-muted-foreground">
                {ws.connected ? (
                  <span className="text-green-600 dark:text-green-400">connected</span>
                ) : (
                  "not connected"
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {!ws.connected && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void guard(async () => {
                      await sl.connect(ws.id);
                      await refresh();
                      reloadSlack();
                    })
                  }
                >
                  <RefreshCw className="mr-1 h-4 w-4" /> Connect
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                disabled={busy}
                onClick={() =>
                  void guard(async () => {
                    await sl.removeWorkspace(ws.id);
                    await refresh();
                    reloadSlack();
                  })
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {adding ? (
        <form
          className="space-y-2 rounded-lg border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void guard(async () => {
              const ws = await sl.saveWorkspace(name.trim(), token.trim(), appToken.trim());
              await sl.connect(ws.id).catch(() => {});
              setName("");
              setToken("");
              setAppToken("");
              setAdding(false);
              await refresh();
              reloadSlack();
            });
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="sl-name" className="text-xs">Workspace name</Label>
            <Input id="sl-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="sl-token" className="text-xs">User or bot token (xoxp- / xoxb-)</Label>
            <Input
              id="sl-token"
              type="password"
              placeholder="xoxp-…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="sl-app" className="text-xs">App-level token (xapp-) — for realtime</Label>
            <Input
              id="sl-app"
              type="password"
              placeholder="xapp-…"
              value={appToken}
              onChange={(e) => setAppToken(e.target.value)}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Create both at api.slack.com/apps → your app. The app token needs Socket Mode
            enabled; a user token sends as you rather than as a bot.
          </p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !name.trim() || !token.trim()}>
              Add workspace
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="mr-1 h-4 w-4" /> Add workspace
        </Button>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

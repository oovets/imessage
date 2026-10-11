// IRC networks, embedded in the Settings dialog.
//
// Defaults are IRCCloud's bouncer: bnc.irccloud.com, 6697, TLS. The password
// comes from IRCCloud's "Connect with another client…" menu on a network and
// looks like bnc:xxxx — the host adds a per-install client id to it, so the
// bouncer replays exactly what this app missed. Everything is stored in the
// keychain by the host; the password never comes back to the webview.

import { useCallback, useEffect, useState } from "react";
import { History, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppStore } from "@/store/useAppStore";
import { irc, onIrcImportProgress } from "@/irc/api";
import type { IrcImportProgress, IrcNetwork } from "@/irc/types";

interface Draft {
  name: string;
  host: string;
  port: string;
  tls: boolean;
  nick: string;
  password: string;
}

const IRCCLOUD_DRAFT: Draft = {
  name: "IRCCloud",
  host: "bnc.irccloud.com",
  port: "6697",
  tls: true,
  nick: "",
  password: "",
};

export function IrcNetworks() {
  const reloadIrc = useAppStore((s) => s.reloadIrc);

  const [networks, setNetworks] = useState<IrcNetwork[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** Set when the form edits an existing network (its name is the key). */
  const [editing, setEditing] = useState<IrcNetwork | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [progress, setProgress] = useState<IrcImportProgress | null>(null);
  const [imported, setImported] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = onIrcImportProgress(setProgress);
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  async function importHistory(net: IrcNetwork) {
    setImporting(net.id);
    setProgress(null);
    setImported(null);
    setError(null);
    try {
      const report = await irc.importIrcCloud(net.id);
      const added = report.buffers.reduce((n, b) => n + b.added, 0);
      const chats = report.buffers.filter((b) => b.added > 0).length;
      setImported(
        added === 0
          ? `Nothing new from IRCCloud's ${report.irccloudNetwork} — already up to date.`
          : `Imported ${added} messages into ${chats} ${chats === 1 ? "chat" : "chats"} from IRCCloud's ${report.irccloudNetwork}.`
      );
      reloadIrc();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(null);
      setProgress(null);
    }
  }

  const refresh = useCallback(async () => {
    try {
      setNetworks((await irc.status()).networks);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Registration happens in the background after connect; poll while the
    // tab is open so "connecting…" turns into "connected" without a reopen.
    const id = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(id);
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

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  const port = Number(draft?.port);
  const canSave =
    !!draft &&
    draft.name.trim() !== "" &&
    draft.host.trim() !== "" &&
    draft.nick.trim() !== "" &&
    Number.isInteger(port) &&
    port > 0 &&
    port < 65536;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {networks.length === 0 && !draft && (
          <p className="text-sm text-muted-foreground">No IRC networks yet.</p>
        )}
        {networks.map((net) => (
          <div key={net.id} className="flex items-center justify-between rounded-lg border px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{net.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {net.connected ? (
                  <span className="text-green-600 dark:text-green-400">
                    connected as {net.currentNick ?? net.nick}
                  </span>
                ) : (
                  "not connected"
                )}{" "}
                · {net.host}:{net.port}
                {net.tls ? "" : " (no TLS)"}
              </div>
            </div>
            <div className="flex items-center gap-1">
              {net.host.endsWith("irccloud.com") && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || importing !== null}
                  aria-label="Import history from IRCCloud"
                  title="Import what IRCCloud already stored (up to 500 lines per chat), logging in with ~/.irc"
                  onClick={() => void importHistory(net)}
                >
                  <History className="h-4 w-4" />
                </Button>
              )}
              {!net.connected && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  title="Start connecting (it retries on its own)"
                  onClick={() =>
                    void guard(async () => {
                      await irc.connect(net.id);
                      await refresh();
                      reloadIrc();
                    })
                  }
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label="Edit"
                onClick={() => {
                  setEditing(net);
                  setDraft({
                    name: net.name,
                    host: net.host,
                    port: String(net.port),
                    tls: net.tls,
                    nick: net.nick,
                    password: "",
                  });
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                disabled={busy}
                aria-label="Remove"
                onClick={() =>
                  void guard(async () => {
                    await irc.removeNetwork(net.id);
                    await refresh();
                    reloadIrc();
                  })
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {importing && (
        <p className="text-xs text-muted-foreground">
          {progress && progress.network_id === importing
            ? `Importing ${progress.buffer} (${progress.index + 1}/${progress.total}) — ${progress.messages} messages…`
            : "Logging in to IRCCloud…"}
        </p>
      )}
      {imported && <p className="text-xs text-green-600 dark:text-green-400">{imported}</p>}

      {draft ? (
        <form
          className="space-y-2 rounded-lg border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSave) return;
            void guard(async () => {
              const net = await irc.saveNetwork({
                name: draft.name.trim(),
                host: draft.host.trim(),
                port,
                tls: draft.tls,
                nick: draft.nick.trim(),
                password: draft.password.trim(),
              });
              await irc.connect(net.id);
              setDraft(null);
              setEditing(null);
              await refresh();
              reloadIrc();
            });
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="irc-name" className="text-xs">Name</Label>
            <Input
              id="irc-name"
              autoFocus
              disabled={!!editing}
              value={draft.name}
              onChange={(e) => update("name", e.target.value)}
            />
          </div>
          <div className="grid grid-cols-[1fr_5.5rem] gap-2">
            <div className="grid gap-1">
              <Label htmlFor="irc-host" className="text-xs">Server</Label>
              <Input
                id="irc-host"
                placeholder="bnc.irccloud.com"
                value={draft.host}
                onChange={(e) => update("host", e.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="irc-port" className="text-xs">Port</Label>
              <Input
                id="irc-port"
                inputMode="numeric"
                value={draft.port}
                onChange={(e) => update("port", e.target.value.replace(/\D/g, ""))}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={draft.tls}
              onChange={(e) => update("tls", e.target.checked)}
              className="h-4 w-4"
            />
            Use TLS
          </label>
          <div className="grid gap-1">
            <Label htmlFor="irc-nick" className="text-xs">Nick</Label>
            <Input
              id="irc-nick"
              autoComplete="off"
              value={draft.nick}
              onChange={(e) => update("nick", e.target.value)}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="irc-pass" className="text-xs">
              {editing?.hasPassword ? "Password (leave empty to keep)" : "Server / bouncer password"}
            </Label>
            <Input
              id="irc-pass"
              type="password"
              placeholder="bnc:…"
              autoComplete="off"
              value={draft.password}
              onChange={(e) => update("password", e.target.value)}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            For IRCCloud: open a network's menu → "Connect with another client…" and generate
            a password there; each IRCCloud network has its own, so add one entry per network.
            In a chat, /me, /join, /part, /msg, /query, /topic and /nick work; start a line with
            // to send a literal slash.
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !canSave}>
              {editing ? "Save" : "Add network"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setEditing(null);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDraft(
              networks.length === 0 ? IRCCLOUD_DRAFT : { ...IRCCLOUD_DRAFT, name: "" }
            );
          }}
        >
          <Plus className="mr-1 h-4 w-4" /> Add network
        </Button>
      )}

      {!draft && error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

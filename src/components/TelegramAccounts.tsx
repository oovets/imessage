// Telegram accounts + login, embedded in the Settings dialog. The interactive
// flows are event-driven: commands kick off a step and the Telegram core
// reports progress via tg:core-event `login` stages, which this component
// consumes to advance its local state machine.

import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { LogOut, Plus, QrCode as QrCodeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppStore } from "@/store/useAppStore";
import { tg, onTelegramEvent } from "@/telegram/api";
import type { TgAccount } from "@/telegram/types";

type LoginStage =
  | { stage: "code_sent" }
  | { stage: "password_required"; hint: string | null }
  | { stage: "qr_code"; url: string; expires_at: string }
  | { stage: "complete" };

type Step =
  | { name: "idle" }
  | { name: "phone" }
  | { name: "code" }
  | { name: "password"; hint: string | null }
  | { name: "qr"; dataUrl: string | null };

export function TelegramAccounts() {
  const available = useAppStore((s) => s.telegramAvailable);
  const reloadTelegram = useAppStore((s) => s.reloadTelegram);

  const [accounts, setAccounts] = useState<TgAccount[]>([]);
  const [step, setStep] = useState<Step>({ name: "idle" });
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setAccounts(await tg.listAccounts());
    } catch {
      /* Telegram unavailable */
    }
  }, []);

  useEffect(() => {
    if (available) void refresh();
  }, [available, refresh]);

  // Drive step transitions from the core's login events.
  useEffect(() => {
    const unlisten = onTelegramEvent(async (raw) => {
      const ev = raw as { kind: string; stage?: LoginStage };
      if (ev.kind !== "login" || !ev.stage) return;
      const stage = ev.stage;
      switch (stage.stage) {
        case "code_sent":
          setStep({ name: "code" });
          break;
        case "password_required":
          setStep({ name: "password", hint: stage.hint });
          break;
        case "qr_code": {
          const dataUrl = await QRCode.toDataURL(stage.url, { width: 208, margin: 1 });
          setStep((cur) => (cur.name === "qr" ? { name: "qr", dataUrl } : cur));
          break;
        }
        case "complete":
          setStep({ name: "idle" });
          setPhone("");
          setCode("");
          setPassword("");
          void refresh();
          reloadTelegram();
          break;
      }
    });
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, [refresh, reloadTelegram]);

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

  function cancel() {
    setStep({ name: "idle" });
    setError(null);
    setCode("");
    setPassword("");
  }

  if (!available) {
    return (
      <p className="text-sm text-muted-foreground">
        Telegram is not configured. Set <code>TG_API_ID</code> and{" "}
        <code>TG_API_HASH</code> (from{" "}
        <span className="font-mono">my.telegram.org</span>) and restart the app.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* Accounts */}
      <div className="space-y-2">
        {accounts.length === 0 && (
          <p className="text-sm text-muted-foreground">No Telegram accounts yet.</p>
        )}
        {accounts.map((a) => (
          <div
            key={a.id}
            className="flex items-center justify-between rounded-lg border px-3 py-2"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">
                {a.first_name}
                {a.last_name ? ` ${a.last_name}` : ""}
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {a.phone ?? (a.username ? `@${a.username}` : `id ${a.id}`)}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={busy}
              onClick={() =>
                void guard(async () => {
                  await tg.signOut(a.id);
                  await refresh();
                  reloadTelegram();
                })
              }
            >
              <LogOut className="h-4 w-4 mr-1" /> Sign out
            </Button>
          </div>
        ))}
      </div>

      {/* Add-account flow */}
      {step.name === "idle" && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setStep({ name: "phone" })}>
            <Plus className="h-4 w-4 mr-1" /> Add account
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void guard(async () => {
                setStep({ name: "qr", dataUrl: null });
                await tg.beginQrLogin();
              })
            }
          >
            <QrCodeIcon className="h-4 w-4 mr-1" /> QR login
          </Button>
        </div>
      )}

      {step.name === "phone" && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void guard(() => tg.beginCodeLogin(phone));
          }}
        >
          <Label htmlFor="tg-phone">Phone number</Label>
          <Input
            id="tg-phone"
            autoFocus
            placeholder="+46 70 123 45 67"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !phone.trim()}>
              Send code
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {step.name === "code" && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void guard(() => tg.submitCode(code));
          }}
        >
          <p className="text-xs text-muted-foreground">
            Enter the code Telegram sent to your app or via SMS.
          </p>
          <Label htmlFor="tg-code">Login code</Label>
          <Input
            id="tg-code"
            autoFocus
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !code.trim()}>
              Sign in
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {step.name === "password" && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void guard(() => tg.submitPassword(password));
          }}
        >
          <p className="text-xs text-muted-foreground">
            Two-step verification is enabled.
            {step.hint ? ` Hint: ${step.hint}` : ""}
          </p>
          <Label htmlFor="tg-pass">Password</Label>
          <Input
            id="tg-pass"
            autoFocus
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !password}>
              Sign in
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {step.name === "qr" && (
        <div className="space-y-2 text-center">
          <p className="text-xs text-muted-foreground">
            Scan in Telegram: Settings → Devices → Link Desktop Device
          </p>
          {step.dataUrl ? (
            <img
              src={step.dataUrl}
              alt="Telegram login QR code"
              className="mx-auto rounded-lg bg-white p-2"
              width={208}
              height={208}
            />
          ) : (
            <div className="mx-auto h-52 w-52 rounded-lg bg-muted flex items-center justify-center text-xs text-muted-foreground">
              Generating…
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

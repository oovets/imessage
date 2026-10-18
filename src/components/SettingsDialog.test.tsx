// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "@/components/ui/dialog";
import SettingsDialogContent from "@/components/SettingsDialog";

vi.mock("@tauri-apps/plugin-autostart", () => ({ enable: vi.fn(), disable: vi.fn() }));
vi.mock("@/components/TelegramAccounts", () => ({ TelegramAccounts: () => <p>telegram accounts</p> }));
vi.mock("@/components/SlackWorkspaces", () => ({ SlackWorkspaces: () => null }));
vi.mock("@/components/IrcNetworks", () => ({ IrcNetworks: () => null }));

function renderSettings() {
  return render(
    <Dialog open>
      <SettingsDialogContent open onOpenChange={() => {}} />
    </Dialog>
  );
}

describe("Settings", () => {
  it("groups sources and app settings as tabs, iMessage first", () => {
    const view = renderSettings();
    const tabs = view.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["iMessage", "Telegram", "Slack", "IRC", "General", "AI replies", "Appearance"]);
    expect(view.getByRole("tab", { name: "iMessage" }).getAttribute("aria-selected")).toBe("true");
    expect(view.getByText("Save & Connect")).toBeTruthy();
  });

  it("keeps Save & Connect to the iMessage tab, and AI replies in their own", () => {
    const view = renderSettings();
    fireEvent.click(view.getByRole("tab", { name: "General" }));
    expect(view.queryByText("Save & Connect")).toBeNull();
    expect(view.queryByLabelText("Endpoint")).toBeNull();

    fireEvent.click(view.getByRole("tab", { name: "AI replies" }));
    expect(view.getByLabelText("Endpoint")).toBeTruthy();
    for (const section of ["Model", "Persona", "Pacing"]) {
      expect(view.getByRole("heading", { name: section })).toBeTruthy();
    }
  });
});

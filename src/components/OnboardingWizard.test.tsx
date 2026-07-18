// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveSecureConfig } from "@/lib/secureConfig";
import { useAppStore } from "@/store/useAppStore";
import { OnboardingWizard } from "./OnboardingWizard";

vi.mock("@/lib/secureConfig", () => ({ saveSecureConfig: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({ installed: false, hasConfig: false }),
  Channel: class {
    onmessage: ((v: unknown) => void) | null = null;
  },
}));
vi.mock("@/components/TelegramAccounts", () => ({ TelegramAccounts: () => null }));

const saveSecureConfigMock = vi.mocked(saveSecureConfig);

function click(el: Element) {
  fireEvent.click(el);
}

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

/** Walk from the label span to the button that actually carries the onClick. */
function chooseManual() {
  const label = screen.getByText("I already have a server");
  click(label.closest("button") ?? label);
}

beforeEach(() => {
  useAppStore.setState({ serverUrl: "", password: "", isConfigured: false });
});

describe("OnboardingWizard keychain failures", () => {
  it("keeps the user on the form and shows the error when the keychain write fails", async () => {
    // Regression: persistConnection swallowed the rejection with .catch(() => {})
    // and called setConfig anyway, so the wizard unmounted claiming the
    // connection was saved — discarding the password the user just entered.
    saveSecureConfigMock.mockRejectedValue(new Error("keychain is locked"));
    render(<OnboardingWizard />);

    chooseManual();
    type(screen.getByPlaceholderText("http://192.168.0.10:1234") as HTMLInputElement, "http://h:1234");
    type(document.querySelectorAll("input")[1] as HTMLInputElement, "secret");
    click(screen.getByText("Connect").closest("button")!);

    await waitFor(() => expect(screen.getByText(/Could not save your connection/i)).toBeTruthy());
    // The app must NOT consider itself configured — that is what unmounts the wizard.
    expect(useAppStore.getState().isConfigured).toBe(false);
  });

  it("marks the app configured only after the keychain write resolves", async () => {
    saveSecureConfigMock.mockResolvedValue(undefined);
    render(<OnboardingWizard />);

    chooseManual();
    type(screen.getByPlaceholderText("http://192.168.0.10:1234") as HTMLInputElement, "http://h:1234");
    type(document.querySelectorAll("input")[1] as HTMLInputElement, "secret");
    click(screen.getByText("Connect").closest("button")!);

    await waitFor(() => expect(useAppStore.getState().isConfigured).toBe(true));
    expect(useAppStore.getState().serverUrl).toBe("http://h:1234");
  });
});

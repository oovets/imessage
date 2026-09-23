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
vi.mock("@/components/SlackWorkspaces", () => ({ SlackWorkspaces: () => null }));

const saveSecureConfigMock = vi.mocked(saveSecureConfig);

function click(el: Element) {
  fireEvent.click(el);
}

function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

function chooseManual() {
  click(screen.getByText("Enter manually"));
}

/** Manual connect marks iMessage ready; the connection is saved on "Open inbox". */
function connectManually() {
  chooseManual();
  type(screen.getByPlaceholderText("http://192.168.0.10:1234") as HTMLInputElement, "http://h:1234");
  type(screen.getByLabelText("Server password") as HTMLInputElement, "secret");
  click(screen.getByText("Connect"));
  click(screen.getByText("Open inbox").closest("button")!);
}

beforeEach(() => {
  useAppStore.setState({ serverUrl: "", password: "", isConfigured: false });
});

describe("OnboardingWizard checklist", () => {
  it("keeps Open inbox disabled until a source is connected", () => {
    saveSecureConfigMock.mockResolvedValue(undefined);
    render(<OnboardingWizard />);
    const open = screen.getByText("Open inbox").closest("button")!;
    expect(open.disabled).toBe(true);

    chooseManual();
    type(screen.getByPlaceholderText("http://192.168.0.10:1234") as HTMLInputElement, "http://h:1234");
    type(screen.getByLabelText("Server password") as HTMLInputElement, "secret");
    click(screen.getByText("Connect"));

    expect(screen.getByText("Open inbox").closest("button")!.disabled).toBe(false);
    expect(screen.getByText("1 / 2 connected")).toBeTruthy();
    // Nothing is saved until the user leaves the wizard.
    expect(saveSecureConfigMock).not.toHaveBeenCalled();
  });
});

describe("OnboardingWizard keychain failures", () => {
  it("keeps the user on the form and shows the error when the keychain write fails", async () => {
    // Regression: persistConnection swallowed the rejection with .catch(() => {})
    // and called setConfig anyway, so the wizard unmounted claiming the
    // connection was saved — discarding the password the user just entered.
    saveSecureConfigMock.mockRejectedValue(new Error("keychain is locked"));
    render(<OnboardingWizard />);

    connectManually();

    await waitFor(() => expect(screen.getByText(/Could not save your connection/i)).toBeTruthy());
    // The app must NOT consider itself configured — that is what unmounts the wizard.
    expect(useAppStore.getState().isConfigured).toBe(false);
  });

  it("marks the app configured only after the keychain write resolves", async () => {
    saveSecureConfigMock.mockResolvedValue(undefined);
    render(<OnboardingWizard />);

    connectManually();

    await waitFor(() => expect(useAppStore.getState().isConfigured).toBe(true));
    expect(useAppStore.getState().serverUrl).toBe("http://h:1234");
  });
});

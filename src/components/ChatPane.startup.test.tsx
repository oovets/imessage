// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/store/useAppStore";
import { tg } from "@/telegram/api";
import { sl } from "@/slack/api";
import { type Chat, type Message, formatMessageTime } from "@/types";
import { ChatPane } from "./ChatPane";

const spy = vi.hoisted(() => ({ listRenders: 0 }));

vi.mock("@/api/clientFactory", () => ({ getClient: vi.fn() }));
vi.mock("@/telegram/api", () => ({ tg: { messages: vi.fn(), markRead: vi.fn() } }));
vi.mock("@/slack/api", () => ({ sl: { history: vi.fn() } }));
// Unmemoized stand-in: counts ChatPane renders that reach the list.
vi.mock("./MessageList", () => ({
  MessageList: () => {
    spy.listRenders++;
    return <div data-testid="history" />;
  },
}));
vi.mock("./MessageInput", () => ({ MessageInput: () => null }));

const TG = "tg:1:2";
const SL = "sl:W1:C1";
const TG_NOT_READY = "Telegram is not ready";
const SL_NOT_CONNECTED = "workspace W1 is not connected";

function chat(guid: string): Chat {
  return {
    guid,
    displayName: guid,
    chatIdentifier: guid,
    participants: [],
    lastMessage: null,
    unreadCount: 0,
  };
}

function cached(guid: string): Message {
  return {
    guid: `${guid}:1`,
    text: "cached",
    isFromMe: false,
    dateCreated: 1_000,
    handle: null,
    attachments: [],
    associatedMessageGuid: "",
    associatedMessageType: "",
    chatGUID: guid,
  };
}

function renderPane(chatGUID: string) {
  return render(<ChatPane paneId="p1" chatGUID={chatGUID} isActive={false} canClose={false} />);
}

/** Let the rejected fetch reach its .catch. */
async function settle() {
  await act(() => new Promise((r) => setTimeout(r, 0)));
}

beforeEach(() => {
  spy.listRenders = 0;
  vi.mocked(tg.messages).mockReset().mockRejectedValue(TG_NOT_READY);
  vi.mocked(tg.markRead).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(sl.history).mockReset().mockRejectedValue(SL_NOT_CONNECTED);
  useAppStore.setState({
    chats: [chat(TG), chat(SL)],
    messages: {},
    messageFetchedAt: {},
    telegramReloadNonce: 0,
    slackReloadNonce: 0,
    slackSelfUserIds: {},
    slackUserNames: {},
  });
});

describe("ChatPane before its backend is ready", () => {
  it("keeps cached Telegram history instead of the not-ready error", async () => {
    useAppStore.setState({ messages: { [TG]: [cached(TG)] } });
    const view = renderPane(TG);
    await settle();
    expect(view.queryByText(TG_NOT_READY)).toBeNull();
    expect(view.getByTestId("history")).toBeTruthy();

    // tg:ready bumps the nonce, which re-runs the load.
    vi.mocked(tg.messages).mockResolvedValue([]);
    act(() => useAppStore.getState().reloadTelegram());
    await settle();
    expect(tg.messages).toHaveBeenCalledTimes(2);
  });

  it("keeps cached Slack history until the workspace connects", async () => {
    useAppStore.setState({ messages: { [SL]: [cached(SL)] } });
    const view = renderPane(SL);
    await settle();
    expect(view.queryByText(SL_NOT_CONNECTED)).toBeNull();
    expect(view.getByTestId("history")).toBeTruthy();

    // Connecting resolves our user id, which re-runs the load.
    vi.mocked(sl.history).mockResolvedValue([]);
    act(() => useAppStore.getState().setSlackSelfUserId("W1", "U1"));
    await settle();
    expect(sl.history).toHaveBeenCalledTimes(2);
  });

  it("still shows the error when there is nothing cached", async () => {
    const tgView = renderPane(TG);
    await settle();
    expect(tgView.getByText(TG_NOT_READY)).toBeTruthy();
    expect(tgView.queryByTestId("history")).toBeNull();
    tgView.unmount();

    const slView = renderPane(SL);
    await settle();
    expect(slView.getByText(SL_NOT_CONNECTED)).toBeTruthy();
  });

  it("still shows any other error over cached history", async () => {
    useAppStore.setState({ messages: { [TG]: [cached(TG)], [SL]: [cached(SL)] } });
    vi.mocked(tg.messages).mockRejectedValue("tg_messages failed: flood wait");
    vi.mocked(sl.history).mockRejectedValue("workspace W2 is not connected");

    const tgView = renderPane(TG);
    await settle();
    expect(tgView.getByText("tg_messages failed: flood wait")).toBeTruthy();
    tgView.unmount();

    // Another workspace's readiness error is not this pane's.
    const slView = renderPane(SL);
    await settle();
    expect(slView.getByText("workspace W2 is not connected")).toBeTruthy();
  });
});

describe("ChatPane memo", () => {
  it("skips a parent re-render with the same props", async () => {
    useAppStore.setState({ messages: { [TG]: [cached(TG)] } });
    vi.mocked(tg.messages).mockResolvedValue([]);
    function Harness() {
      const [n, setN] = useState(0);
      return (
        <>
          <button onClick={() => setN(n + 1)}>bump</button>
          <ChatPane paneId="p1" chatGUID={TG} isActive={n > 1} canClose={false} />
        </>
      );
    }
    const view = render(<Harness />);
    await settle();
    const before = spy.listRenders;

    fireEvent.click(view.getByText("bump"));
    expect(spy.listRenders).toBe(before);

    // A prop that did change still renders.
    fireEvent.click(view.getByText("bump"));
    expect(spy.listRenders).toBe(before + 1);
  });
});

describe("ChatPane last-seen label", () => {
  const DAY = 24 * 60 * 60_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    useAppStore.setState({ telegramPresence: {} });
  });

  it("re-renders the header when 'last seen' is due to change", () => {
    const seen = new Date(2026, 8, 22, 15, 0).getTime();
    vi.setSystemTime(seen + DAY - 60_000);
    useAppStore.setState({
      messages: { [TG]: [cached(TG)] },
      telegramPresence: { [TG]: { online: false, lastSeen: seen } },
    });
    const view = renderPane(TG);
    const before = `last seen ${formatMessageTime(seen)}`;
    expect(view.getByText(before)).toBeTruthy();

    act(() => vi.advanceTimersByTime(60_000 - 1));
    expect(view.getByText(before)).toBeTruthy();

    // 24 h on, the time reads as a weekday.
    act(() => vi.advanceTimersByTime(1));
    const after = `last seen ${formatMessageTime(seen)}`;
    expect(after).not.toBe(before);
    expect(view.getByText(after)).toBeTruthy();
  });
});

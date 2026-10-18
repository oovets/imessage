// BlueBubbles history fetches still running, by chat. A pane opening a chat
// fetches its history; the polling fallback restarts on the same selection
// and polled it at once as well, fetching the same messages twice.
const inFlight = new Map<string, Promise<unknown>>();

/** Marks `request` as the history fetch for `chatGUID` until it settles. */
export function trackHistoryFetch<T>(chatGUID: string, request: Promise<T>): Promise<T> {
  inFlight.set(chatGUID, request);
  // Registered before the caller's handlers, so the entry is gone by the time
  // the caller acts on the result.
  const settle = () => {
    if (inFlight.get(chatGUID) === request) inFlight.delete(chatGUID);
  };
  request.then(settle, settle);
  return request;
}

export function isHistoryFetchInFlight(chatGUID: string): boolean {
  return inFlight.has(chatGUID);
}

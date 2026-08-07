import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { beforeAll, describe, expect, it, vi } from "vitest";

type WorkerHandler = (event: Record<string, unknown>) => void;

let source = "";

beforeAll(async () => {
  source = await readFile(new URL("../web/static/sw.js", import.meta.url), "utf8");
});

describe("service worker notification deep links", () => {
  it("focuses an existing app window and sends the selected session", async () => {
    const postMessage = vi.fn();
    const focus = vi.fn(async () => undefined);
    const { handlers } = loadWorker({
      matchAll: vi.fn(async () => [{ url: "https://pi.example/current", postMessage, focus }]),
      openWindow: vi.fn(),
    });
    await dispatchNotificationClick(handlers, { sessionId: "session-1", url: "/?session=session-1" });
    expect(postMessage).toHaveBeenCalledWith({ type: "open-session", sessionId: "session-1" });
    expect(focus).toHaveBeenCalledOnce();
  });

  it("opens the session deep link when no app window exists", async () => {
    const openWindow = vi.fn(async () => undefined);
    const { handlers } = loadWorker({ matchAll: vi.fn(async () => []), openWindow });
    await dispatchNotificationClick(handlers, { sessionId: "session 2", url: "/?session=session%202" });
    expect(openWindow).toHaveBeenCalledWith("https://pi.example/?session=session%202");
  });
});

function loadWorker(clients: { matchAll: ReturnType<typeof vi.fn>; openWindow: ReturnType<typeof vi.fn> }) {
  const handlers: Record<string, WorkerHandler> = {};
  const cache = { addAll: vi.fn(async () => undefined), match: vi.fn(), put: vi.fn() };
  const worker = {
    location: { origin: "https://pi.example" },
    registration: { showNotification: vi.fn(async () => undefined) },
    clients: { ...clients, claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(),
    addEventListener: (type: string, handler: WorkerHandler) => { handlers[type] = handler; },
  };
  runInNewContext(source, {
    self: worker,
    URL,
    fetch: vi.fn(),
    caches: {
      open: vi.fn(async () => cache),
      keys: vi.fn(async () => []),
      delete: vi.fn(async () => true),
    },
  });
  return { handlers, worker };
}

async function dispatchNotificationClick(handlers: Record<string, WorkerHandler>, data: Record<string, unknown>) {
  let operation: Promise<unknown> | undefined;
  const close = vi.fn();
  handlers.notificationclick?.({
    notification: { data, close },
    waitUntil: (promise: Promise<unknown>) => { operation = promise; },
  });
  await operation;
  expect(close).toHaveBeenCalledOnce();
}

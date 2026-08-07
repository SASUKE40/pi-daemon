// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toast } from "@base-ui/react/toast";
import { Tooltip } from "@base-ui/react/tooltip";
import { NotificationSettings, PiDaemonApp, ToastViewport } from "../web/app.js";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string | URL) {
    FakeWebSocket.instances.push(this);
  }

  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; }
  emit(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
      get length() { return values.size; },
    },
  });
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class { observe() {} unobserve() {} disconnect() {} },
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/bootstrap") return jsonResponse({ protocolVersion: 1, version: "test", defaultCwd: "/workspace", local: true, pushPublicKey: "AQIDBA" });
    if (url === "/api/attachments" && init?.method === "POST") return jsonResponse({ attachments: [{ id: "image-1", name: "screen.png", mimeType: "image/png", size: 8 }] });
    return jsonResponse({ ok: true });
  }));
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window.navigator, "serviceWorker");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiDaemonApp", () => {
  it("connects, restores server state, and preserves core session commands", async () => {
    const user = userEvent.setup();
    render(<Tooltip.Provider><Toast.Provider><PiDaemonApp /><ToastViewport /></Toast.Provider></Tooltip.Provider>);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    await act(async () => socket?.onopen?.());
    expect(commands(socket)).toContainEqual(expect.objectContaining({ type: "session.list" }));

    await act(async () => {
      socket?.emit({ type: "ready", protocolVersion: 1 });
      socket?.emit({
        type: "session.list",
        protocolVersion: 1,
        requestId: "list",
        sessions: [{ id: "session-1", path: "/sessions/1", cwd: "/workspace/project", name: "Release repair", created: new Date().toISOString(), modified: new Date().toISOString(), messageCount: 2, firstMessage: "Repair it" }],
      });
      socket?.emit({
        type: "session.snapshot",
        protocolVersion: 1,
        session: {
          id: "session-1",
          cwd: "/workspace/project",
          name: "Release repair",
          thinking: "medium",
          streaming: false,
          messages: [{ role: "assistant", content: [{ type: "text", text: "## Ready to work\n\n- **Safe** Markdown" }] }],
          model: { provider: "openai", id: "gpt-test", name: "Test model" },
          availableModels: [
            { provider: "openai", id: "gpt-test", name: "Test model" },
            { provider: "anthropic", id: "claude-test", name: "Claude test" },
          ],
        },
      });
    });

    expect(await screen.findByRole("heading", { name: "Release repair" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Ready to work" })).toBeTruthy();
    expect((await screen.findByText("Safe")).closest('[data-streamdown="strong"]')).not.toBeNull();
    expect(screen.getByRole("listitem").textContent).toContain("Markdown");

    await user.click(screen.getByRole("combobox", { name: "Thinking" }));
    await user.click(await screen.findByRole("option", { name: "Think: high" }));
    expect(commands(socket)).toContainEqual(expect.objectContaining({ type: "session.setThinking", sessionId: "session-1", thinking: "high" }));

    await user.click(screen.getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: /Claude test/ }));
    expect(commands(socket)).toContainEqual(expect.objectContaining({ type: "session.setModel", sessionId: "session-1", provider: "anthropic", modelId: "claude-test" }));

    const textarea = screen.getByRole("textbox", { name: "Message Pi" });
    await user.type(textarea, "Run the tests");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(commands(socket)).toContainEqual(expect.objectContaining({ type: "session.prompt", sessionId: "session-1", text: "Run the tests" }));

    await act(async () => {
      socket?.emit({ type: "session.status", protocolVersion: 1, sessionId: "session-1", seq: 1, status: "running" });
      socket?.emit({ type: "session.event", protocolVersion: 1, sessionId: "session-1", seq: 2, event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "**Working now" }] } } });
    });
    await waitFor(() => expect(document.querySelector('.message.live [data-streamdown="strong"]')?.textContent?.replace(/\s+/gu, " ").trim()).toBe("Working now"));
    await user.type(textarea, "Continue afterward");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(commands(socket)).toContainEqual(expect.objectContaining({ type: "session.followUp", text: "Continue afterward" }));

    await user.click(screen.getByRole("combobox", { name: "Message delivery" }));
    await user.click(await screen.findByRole("option", { name: "Steer now" }));
    await user.type(textarea, "Change direction");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(commands(socket)).toContainEqual(expect.objectContaining({ type: "session.steer", text: "Change direction" }));
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(commands(socket)).toContainEqual(expect.objectContaining({ type: "session.abort", sessionId: "session-1" }));

    await act(async () => socket?.emit({ type: "session.status", protocolVersion: 1, sessionId: "session-1", seq: 3, status: "idle" }));

    const uploadInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(uploadInput).not.toBeNull();
    const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "screen.png", { type: "image/png" });
    await act(async () => fireEvent.change(uploadInput as HTMLInputElement, { target: { files: [file] } }));
    expect(await screen.findByText("screen.png")).toBeTruthy();
    await user.type(textarea, "Inspect this");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(commands(socket)).toContainEqual(expect.objectContaining({
      type: "session.prompt",
      text: "Inspect this",
      attachments: [{ id: "image-1", mimeType: "image/png" }],
    }));
  });

  it("uses Base UI dialogs for new sessions and unsupported notification guidance", async () => {
    const user = userEvent.setup();
    render(<Tooltip.Provider><Toast.Provider><PiDaemonApp /><ToastViewport /></Toast.Provider></Tooltip.Provider>);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    await act(async () => socket?.onopen?.());

    await user.click(screen.getByRole("button", { name: "Open sessions" }));
    const drawer = await screen.findByRole("dialog", { name: "Sessions" });
    await user.click(within(drawer).getByRole("button", { name: /new session/i }));
    const dialog = await screen.findByRole("dialog", { name: "Start a new session" });
    const cwd = within(dialog).getByLabelText("Working directory");
    await user.clear(cwd);
    await user.type(cwd, "/tmp/project");
    await user.type(within(dialog).getByLabelText(/Session name/), "New work");
    await user.click(within(dialog).getByRole("button", { name: "Create session" }));
    expect(commands(socket)).toContainEqual(expect.objectContaining({ type: "session.create", cwd: "/tmp/project", name: "New work" }));

    await user.click(screen.getByRole("button", { name: "Notification settings" }));
    expect(await screen.findByText("Not supported here")).toBeTruthy();
    expect(screen.getByText(/Service Worker and Push APIs/)).toBeTruthy();
  });

  it("prioritizes URL and service-worker session deep links, reconnects, and deduplicates outage toasts", async () => {
    window.localStorage.setItem("pi-daemon-last-session", "remembered-session");
    window.history.replaceState({}, "", "/?session=query-session");
    const serviceWorker = new EventTarget() as EventTarget & { register: ReturnType<typeof vi.fn> };
    serviceWorker.register = vi.fn(async () => ({}));
    Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: serviceWorker });

    render(<Tooltip.Provider><Toast.Provider><PiDaemonApp /><ToastViewport /></Toast.Provider></Tooltip.Provider>);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      socket?.onopen?.();
      socket?.emit({ type: "ready", protocolVersion: 1, activeSessionId: "server-session" });
    });
    expect(commands(socket)).toContainEqual(expect.objectContaining({ type: "session.open", sessionId: "query-session" }));
    expect(serviceWorker.register).toHaveBeenCalledWith("/sw.js");

    await act(async () => serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "open-session", sessionId: "notification-session" } })));
    expect(commands(socket)).toContainEqual(expect.objectContaining({ type: "session.open", sessionId: "notification-session" }));

    await act(async () => {
      socket?.emit({ type: "error", protocolVersion: 1, code: "daemon_unavailable", message: "Session daemon disconnected" });
      socket?.emit({ type: "error", protocolVersion: 1, code: "daemon_unavailable", message: "Session daemon disconnected" });
    });
    await waitFor(() => expect(document.querySelectorAll(".toastRoot")).toHaveLength(1));

    await act(async () => socket?.onclose?.());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 1_500 });
  });
});

describe("NotificationSettings", () => {
  it("explains the iOS Home Screen requirement before requesting permission", async () => {
    const requestPermission = installPushEnvironment(null, "default");
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    render(<Toast.Provider><NotificationSettings publicKey="AQIDBA" showError={vi.fn()} /></Toast.Provider>);
    expect(await screen.findByText("Add Pi to your Home Screen")).toBeTruthy();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("shows denied permission without requesting it again", async () => {
    const requestPermission = installPushEnvironment(null, "denied");
    render(<Toast.Provider><NotificationSettings publicKey="AQIDBA" showError={vi.fn()} /></Toast.Provider>);
    expect(await screen.findByText("Permission is blocked")).toBeTruthy();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("requests permission only after Enable and synchronizes the new subscription", async () => {
    const subscription = pushSubscription([1, 2, 3, 4]);
    const requestPermission = installPushEnvironment(null, "default", subscription);
    const user = userEvent.setup();
    render(<Toast.Provider><NotificationSettings publicKey="AQIDBA" showError={vi.fn()} /></Toast.Provider>);
    expect(await screen.findByText("Notifications are off")).toBeTruthy();
    expect(requestPermission).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Enable notifications" }));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Notifications are on")).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/push/subscription", expect.objectContaining({ method: "PUT" }));
  });

  it("synchronizes an existing matching subscription on startup", async () => {
    installPushEnvironment(pushSubscription([1, 2, 3, 4]), "granted");
    render(<Toast.Provider><NotificationSettings publicKey="AQIDBA" showError={vi.fn()} /></Toast.Provider>);
    expect(await screen.findByText("Notifications are on")).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/push/subscription", expect.objectContaining({ method: "PUT" }));
  });
});

function commands(socket: FakeWebSocket | undefined): Array<Record<string, unknown>> {
  return (socket?.sent || []).map((value) => JSON.parse(value) as Record<string, unknown>);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function installPushEnvironment(existing: PushSubscription | null, permission: NotificationPermission, created?: PushSubscription) {
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  const pushManager = {
    getSubscription: vi.fn(async () => existing),
    subscribe: vi.fn(async () => created || pushSubscription([1, 2, 3, 4])),
  };
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: { ready: Promise.resolve({ pushManager }) },
  });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { permission, requestPermission });
  return requestPermission;
}

function pushSubscription(applicationServerKey: number[]): PushSubscription {
  return {
    endpoint: "https://push.example.test/device",
    expirationTime: null,
    options: { applicationServerKey: new Uint8Array(applicationServerKey).buffer, userVisibleOnly: true },
    getKey: vi.fn(),
    toJSON: () => ({ endpoint: "https://push.example.test/device", expirationTime: null, keys: { p256dh: "public", auth: "auth" } }),
    unsubscribe: vi.fn(async () => true),
  } as unknown as PushSubscription;
}

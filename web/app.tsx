import { lazy, StrictMode, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import { Combobox } from "@base-ui/react/combobox";
import { Dialog } from "@base-ui/react/dialog";
import { Input } from "@base-ui/react/input";
import { Menu } from "@base-ui/react/menu";
import { Select } from "@base-ui/react/select";
import { Toast } from "@base-ui/react/toast";
import { Tooltip } from "@base-ui/react/tooltip";
import anthropicProviderIcon from "@lobehub/icons-static-svg/icons/anthropic.svg?url";
import geminiProviderIcon from "@lobehub/icons-static-svg/icons/gemini.svg?url";
import mistralProviderIcon from "@lobehub/icons-static-svg/icons/mistral.svg?url";
import openAiProviderIcon from "@lobehub/icons-static-svg/icons/openai.svg?url";
import xAiProviderIcon from "@lobehub/icons-static-svg/icons/xai.svg?url";
import type { ClientCommand, ServerEvent, SessionSnapshot, SessionSummary, SlashCommand, ThinkingLevel } from "../src/protocol.ts";
import "streamdown/styles.css";
import "./app.css";

const StreamdownRenderer = lazy(() => import("streamdown").then(({ Streamdown }) => ({ default: Streamdown })));

interface Bootstrap {
  protocolVersion: 1;
  version: string;
  defaultCwd: string;
  hostname?: string;
  local: boolean;
  pushPublicKey?: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

interface UploadedAttachment {
  id: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  size: number;
  previewUrl: string;
}

type UploadedAttachmentMetadata = Omit<UploadedAttachment, "previewUrl">;

interface ToolActivity {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  status: "queued" | "running" | "complete" | "error";
}

type TimelineRow =
  | { kind: "item"; item: unknown; key: string }
  | { kind: "activity"; tools: ToolActivity[]; key: string };

type SessionStatus = "idle" | "running" | "aborting" | "error";
type Theme = "light" | "dark";

interface AppState {
  connected: boolean;
  daemonConnected: boolean;
  sessions: SessionSummary[];
  current?: SessionSnapshot;
  timeline: unknown[];
  status: SessionStatus;
  queue: { steering: readonly string[]; followUp: readonly string[] };
}

type AppAction =
  | { type: "socket.open" }
  | { type: "socket.close" }
  | { type: "daemon.ready" }
  | { type: "session.list"; sessions: SessionSummary[] }
  | { type: "session.snapshot"; session: SessionSnapshot }
  | { type: "session.event"; value: unknown }
  | { type: "session.status"; status: SessionStatus }
  | { type: "queue.update"; steering: readonly string[]; followUp: readonly string[] };

const initialState: AppState = {
  connected: false,
  daemonConnected: false,
  sessions: [],
  timeline: [],
  status: "idle",
  queue: { steering: [], followUp: [] },
};

export function installTouchZoomGuard(target: Document, maxTouchPoints: number): () => void {
  if (maxTouchPoints < 2) return () => undefined;
  const options: AddEventListenerOptions = { passive: false };
  const preventGestureZoom = (event: Event) => event.preventDefault();
  const preventMultiTouchZoom = (event: Event) => {
    if ((event as TouchEvent).touches.length > 1) event.preventDefault();
  };
  target.addEventListener("gesturestart", preventGestureZoom, options);
  target.addEventListener("gesturechange", preventGestureZoom, options);
  target.addEventListener("gestureend", preventGestureZoom, options);
  target.addEventListener("touchstart", preventMultiTouchZoom, options);
  target.addEventListener("touchmove", preventMultiTouchZoom, options);
  return () => {
    target.removeEventListener("gesturestart", preventGestureZoom, options);
    target.removeEventListener("gesturechange", preventGestureZoom, options);
    target.removeEventListener("gestureend", preventGestureZoom, options);
    target.removeEventListener("touchstart", preventMultiTouchZoom, options);
    target.removeEventListener("touchmove", preventMultiTouchZoom, options);
  };
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "socket.open": return { ...state, connected: true, daemonConnected: true };
    case "socket.close": return { ...state, connected: false, daemonConnected: false };
    case "daemon.ready": return { ...state, daemonConnected: true };
    case "session.list": return { ...state, sessions: action.sessions };
    case "session.snapshot": return {
      ...state,
      current: action.session,
      timeline: [...action.session.messages],
      status: action.session.streaming ? "running" : "idle",
      queue: { steering: [], followUp: [] },
    };
    case "session.event": return { ...state, timeline: applyAgentEvent(state.timeline, action.value) };
    case "session.status": return { ...state, status: action.status, ...(action.status === "idle" ? { queue: { steering: [], followUp: [] } } : {}) };
    case "queue.update": return { ...state, queue: { steering: action.steering, followUp: action.followUp } };
  }
}

function applyAgentEvent(timeline: unknown[], value: unknown): unknown[] {
  if (!value || typeof value !== "object") return timeline;
  const event = value as Record<string, unknown>;
  const type = String(event.type || "event");
  if (["message_start", "message_update", "message_end"].includes(type) && event.message) {
    const withoutLive = timeline.filter((item) => !(item && typeof item === "object" && (item as Record<string, unknown>).__live));
    return type === "message_end" ? [...withoutLive, event.message] : [...withoutLive, { __live: true, message: event.message }];
  }
  if (["turn_start", "turn_end", "agent_start", "agent_end", "agent_settled", "entry_appended"].includes(type)) return timeline;
  return [...timeline, value];
}

export function PiDaemonApp(): ReactNode {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => isStandalone());
  const [theme, setTheme] = useState<Theme>(() => initialTheme());
  const [newSessionCwd, setNewSessionCwd] = useState("");
  const [newSessionName, setNewSessionName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [nearBottom, setNearBottom] = useState(true);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const reconnectRef = useRef<number | undefined>(undefined);
  const daemonUnavailableRef = useRef(false);
  const attachmentUrlsRef = useRef(new Set<string>());
  const stateRef = useRef(state);
  const preferredSessionRef = useRef<string | null>(new URL(window.location.href).searchParams.get("session"));
  const timelineRef = useRef<HTMLElement>(null);
  const toasts = Toast.useToastManager();
  const toastRef = useRef(toasts);
  stateRef.current = state;
  toastRef.current = toasts;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("pi-daemon-theme", theme);
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#111a1f" : "#f7fafb");
  }, [theme]);

  const showError = useCallback((message: string) => {
    toastRef.current.add({ title: "Something went wrong", description: message, type: "error", priority: "high" });
  }, []);

  const send = useCallback((command: Record<string, unknown>) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return;
    const envelope = { protocolVersion: 1, requestId: crypto.randomUUID(), ...command } as ClientCommand;
    socketRef.current.send(JSON.stringify(envelope));
  }, []);

  useEffect(() => {
    const captureInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const markInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("appinstalled", markInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
      window.removeEventListener("appinstalled", markInstalled);
    };
  }, []);

  useEffect(() => {
    let stopped = false;

    const receive = (message: ServerEvent) => {
      switch (message.type) {
        case "ready": {
          dispatch({ type: "daemon.ready" });
          const resumeId = preferredSessionRef.current || message.activeSessionId || window.localStorage.getItem("pi-daemon-last-session");
          if (resumeId) send({ type: "session.open", sessionId: resumeId });
          break;
        }
        case "session.list":
          daemonUnavailableRef.current = false;
          dispatch({ type: "session.list", sessions: message.sessions });
          break;
        case "session.snapshot": {
          daemonUnavailableRef.current = false;
          dispatch({ type: "session.snapshot", session: message.session });
          window.localStorage.setItem("pi-daemon-last-session", message.session.id);
          if (preferredSessionRef.current === message.session.id) {
            preferredSessionRef.current = null;
            const url = new URL(window.location.href);
            url.searchParams.delete("session");
            window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
          }
          setSidebarOpen(false);
          send({ type: "session.list" });
          break;
        }
        case "session.event":
          daemonUnavailableRef.current = false;
          if (message.sessionId === stateRef.current.current?.id) dispatch({ type: "session.event", value: message.event });
          break;
        case "session.status":
          daemonUnavailableRef.current = false;
          if (message.sessionId === stateRef.current.current?.id) dispatch({ type: "session.status", status: message.status });
          if (message.message) showError(message.message);
          if (message.status === "idle") {
            send({ type: "session.open", sessionId: message.sessionId });
            send({ type: "session.list" });
          }
          break;
        case "queue.update":
          daemonUnavailableRef.current = false;
          if (message.sessionId === stateRef.current.current?.id) dispatch({ type: "queue.update", steering: message.steering, followUp: message.followUp });
          break;
        case "error":
          if (message.code === "daemon_unavailable") {
            dispatch({ type: "socket.close" });
            if (daemonUnavailableRef.current) break;
            daemonUnavailableRef.current = true;
          }
          if (message.activeSessionId) send({ type: "session.open", sessionId: message.activeSessionId });
          showError(message.message);
          break;
      }
    };

    const connect = () => {
      if (stopped) return;
      const url = new URL("/api/ws", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      socketRef.current = socket;
      socket.onopen = () => {
        dispatch({ type: "socket.open" });
        send({ type: "session.list" });
      };
      socket.onclose = () => {
        dispatch({ type: "socket.close" });
        if (!stopped) reconnectRef.current = window.setTimeout(connect, 1_000);
      };
      socket.onerror = () => dispatch({ type: "socket.close" });
      socket.onmessage = (event) => {
        try {
          receive(JSON.parse(String(event.data)) as ServerEvent);
        } catch {
          showError("The server sent an unreadable response.");
        }
      };
    };

    const serviceWorkerMessage = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | undefined;
      if (data?.type !== "open-session" || typeof data.sessionId !== "string") return;
      preferredSessionRef.current = data.sessionId;
      send({ type: "session.open", sessionId: data.sessionId });
    };

    void (async () => {
      try {
        const response = await fetch("/api/bootstrap");
        if (!response.ok) throw new Error(`Unable to start Pi Daemon (${response.status})`);
        const value = await response.json() as Bootstrap;
        if (stopped) return;
        setBootstrap(value);
        setNewSessionCwd(value.defaultCwd);
        if ("serviceWorker" in navigator) {
          await navigator.serviceWorker.register("/sw.js");
          navigator.serviceWorker.addEventListener("message", serviceWorkerMessage);
        }
        connect();
      } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => {
      stopped = true;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      socketRef.current?.close();
      navigator.serviceWorker?.removeEventListener("message", serviceWorkerMessage);
    };
  }, [send, showError]);

  useEffect(() => {
    if (!nearBottom) return;
    window.requestAnimationFrame(() => {
      const element = timelineRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }, [nearBottom, state.current?.id, state.timeline]);

  const filteredSessions = useMemo(() => {
    const query = sessionFilter.trim().toLocaleLowerCase();
    if (!query) return state.sessions;
    return state.sessions.filter((session) => [session.name, session.firstMessage, session.cwd].some((value) => value?.toLocaleLowerCase().includes(query)));
  }, [sessionFilter, state.sessions]);

  const submit = () => {
    const text = draft.trim();
    if (!text || !state.current) return;
    const type = state.status === "running" ? "session.steer" : "session.prompt";
    send({
      type,
      sessionId: state.current.id,
      text,
      attachments: attachments.map(({ id, mimeType }) => ({ id, mimeType })),
    });
    for (const attachment of attachments) {
      URL.revokeObjectURL(attachment.previewUrl);
      attachmentUrlsRef.current.delete(attachment.previewUrl);
    }
    setDraft("");
    setAttachments([]);
    setNearBottom(true);
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const selectedFiles = Array.from(files);
    const form = new FormData();
    for (const file of selectedFiles) form.append("image", file);
    try {
      const response = await fetch("/api/attachments", { method: "POST", body: form });
      const result = await response.json() as { attachments?: UploadedAttachmentMetadata[]; error?: string };
      if (!response.ok) throw new Error(result.error || "Upload failed");
      const uploaded = (result.attachments || []).flatMap((attachment, index) => {
        const file = selectedFiles[index];
        if (!file) return [];
        const previewUrl = URL.createObjectURL(file);
        attachmentUrlsRef.current.add(previewUrl);
        return [{ ...attachment, previewUrl }];
      });
      setAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => () => {
    for (const previewUrl of attachmentUrlsRef.current) URL.revokeObjectURL(previewUrl);
    attachmentUrlsRef.current.clear();
  }, []);

  const createSession = (event: FormEvent) => {
    event.preventDefault();
    const cwd = newSessionCwd.trim();
    if (!cwd) return;
    send({ type: "session.create", cwd, ...(newSessionName.trim() ? { name: newSessionName.trim() } : {}) });
    setNewSessionName("");
    setNewSessionOpen(false);
  };

  const renameSession = (event: FormEvent) => {
    event.preventDefault();
    if (!state.current || !renameValue.trim()) return;
    send({ type: "session.rename", sessionId: state.current.id, name: renameValue.trim() });
    setRenameOpen(false);
  };

  const title = state.current?.name || (state.current?.messages.length ? "Pi session" : "New session");
  const connectionLabel = state.connected && state.daemonConnected ? "Connected" : "Reconnecting";

  return (
    <div className="appShell">
      <aside className="sessionRail" aria-label="Sessions">
        <SessionSidebar
          sessions={filteredSessions}
          currentId={state.current?.id}
          connected={state.connected && state.daemonConnected}
          filter={sessionFilter}
          onFilter={setSessionFilter}
          onCreate={() => setNewSessionOpen(true)}
          onOpen={(sessionId) => send({ type: "session.open", sessionId })}
        />
      </aside>

      <main className="workspace">
        <header className="sessionHeader">
          <TipButton className="iconButton mobileOnly" label="Open sessions" onClick={() => setSidebarOpen(true)}>☰</TipButton>
          <div className="sessionHeading">
            <div className="eyebrow"><span className={`statusDot ${state.connected && state.daemonConnected ? state.status : "disconnected"}`} />{connectionLabel}</div>
            <h1>{title}</h1>
            <p>{state.current?.cwd || bootstrap?.defaultCwd || "Starting…"}</p>
          </div>
          <div className="headerActions">
            <span className="srOnly" aria-live="polite">Run status: {state.status}</span>
            <Menu.Root>
              <Menu.Trigger className="iconButton" aria-label="Session actions">•••</Menu.Trigger>
              <Menu.Portal>
                <Menu.Positioner className="popupPositioner" sideOffset={8} align="end">
                  <Menu.Popup className="menuPopup">
                    <div className="menuStatus" role="presentation">
                      <span className={`menuStatusDot ${state.status}`} aria-hidden="true" />
                      <span>Run status</span>
                      <small>{state.status}</small>
                    </div>
                    <Menu.Separator className="menuSeparator" />
                    <Menu.Item className="menuItem menuActionItem" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}><ThemeIcon theme={theme} /><span>Use {theme === "dark" ? "light" : "dark"} theme</span></Menu.Item>
                    <Menu.Item className="menuItem menuActionItem" onClick={() => setInstallOpen(true)}><InstallIcon /><span>Add to Home Screen</span></Menu.Item>
                    {state.current && <Menu.Item className="menuItem menuActionItem" onClick={() => { setRenameValue(state.current?.name || ""); setRenameOpen(true); }}><RenameIcon /><span>Rename session</span></Menu.Item>}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          </div>
        </header>

        <section
          className="timeline"
          ref={timelineRef}
          aria-live="polite"
          onScroll={(event) => {
            const element = event.currentTarget;
            setNearBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 96);
          }}
        >
          <div className="timelineInner">
            {state.timeline.length ? buildTimelineRows(state.timeline).map((row) => row.kind === "activity"
              ? <ToolActivityGroup key={row.key} tools={row.tools} />
              : <TimelineItem key={row.key} item={row.item} />) : <EmptyState connected={state.connected} hasSession={Boolean(state.current)} onCreate={() => setNewSessionOpen(true)} />}
          </div>
        </section>

        {!nearBottom && <Button className="jumpButton" onClick={() => { setNearBottom(true); timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: "smooth" }); }}>Jump to latest ↓</Button>}

        <Composer
          current={state.current}
          status={state.status}
          queue={state.queue}
          draft={draft}
          attachments={attachments}
          onDraft={setDraft}
          onUpload={upload}
          onRemoveAttachment={(id) => setAttachments((current) => current.filter((attachment) => {
            if (attachment.id !== id) return true;
            URL.revokeObjectURL(attachment.previewUrl);
            attachmentUrlsRef.current.delete(attachment.previewUrl);
            return false;
          }))}
          onSubmit={submit}
          onAbort={() => { if (state.current) send({ type: "session.abort", sessionId: state.current.id }); }}
          onModel={(model) => { if (state.current) send({ type: "session.setModel", sessionId: state.current.id, provider: model.provider, modelId: model.id }); }}
          onThinking={(thinking) => { if (state.current) send({ type: "session.setThinking", sessionId: state.current.id, thinking }); }}
        />
      </main>

      <AppDialog open={sidebarOpen} onOpenChange={setSidebarOpen} popupClassName="mobileSessionDrawer" title="Sessions" description="Open or create a Pi session.">
        <SessionSidebar
          sessions={filteredSessions}
          currentId={state.current?.id}
          connected={state.connected && state.daemonConnected}
          filter={sessionFilter}
          onFilter={setSessionFilter}
          onCreate={() => { setSidebarOpen(false); setNewSessionOpen(true); }}
          onOpen={(sessionId) => { send({ type: "session.open", sessionId }); setSidebarOpen(false); }}
        />
      </AppDialog>

      <AppDialog open={newSessionOpen} onOpenChange={setNewSessionOpen} title="Start a new session" description="Choose the workspace Pi can work in.">
        <form className="dialogForm" onSubmit={createSession}>
          <label className="fieldLabel" htmlFor="new-session-cwd">Working directory</label>
          <Input id="new-session-cwd" className="textInput" value={newSessionCwd} onChange={(event) => setNewSessionCwd(event.target.value)} required autoFocus />
          <label className="fieldLabel" htmlFor="new-session-name">Session name <span>optional</span></label>
          <Input id="new-session-name" className="textInput" value={newSessionName} onChange={(event) => setNewSessionName(event.target.value)} placeholder="e.g. Repair the release pipeline" />
          <div className="dialogActions"><Dialog.Close className="secondaryButton">Cancel</Dialog.Close><Button className="primaryButton" type="submit">Create session</Button></div>
        </form>
      </AppDialog>

      <AppDialog open={renameOpen} onOpenChange={setRenameOpen} title="Rename session" description="Give this work a clear, memorable name.">
        <form className="dialogForm" onSubmit={renameSession}>
          <label className="fieldLabel" htmlFor="rename-session">Session name</label>
          <Input id="rename-session" className="textInput" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} required autoFocus />
          <div className="dialogActions"><Dialog.Close className="secondaryButton">Cancel</Dialog.Close><Button className="primaryButton" type="submit">Save name</Button></div>
        </form>
      </AppDialog>

      <AppDialog open={installOpen} onOpenChange={setInstallOpen} title="Add Pi to your Home Screen" description="Install Pi for quick access and a full-screen app experience.">
        <InstallGuidance
          installed={installed}
          promptEvent={installPrompt}
          onPromptUsed={() => setInstallPrompt(null)}
          onInstalled={() => setInstalled(true)}
          showError={showError}
        />
        <div className="dialogSection">
          <h3>Completion notifications</h3>
          <p>Get an alert when Pi finishes, even after the app is closed.</p>
          {bootstrap ? <NotificationSettings publicKey={bootstrap.pushPublicKey} showError={showError} /> : <p className="mutedCopy">Preparing notification settings…</p>}
        </div>
      </AppDialog>
    </div>
  );
}

function SessionSidebar(props: {
  sessions: SessionSummary[];
  currentId: string | undefined;
  connected: boolean;
  filter: string;
  onFilter(value: string): void;
  onCreate(): void;
  onOpen(sessionId: string): void;
}): ReactNode {
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchOpen = searchExpanded || Boolean(props.filter);
  const closeSearch = () => {
    props.onFilter("");
    setSearchExpanded(false);
  };

  return (
    <div className="sidebarContent">
      <div className="brandRow">
        <PiMark className="brandMark" />
        <div><strong>PI Remote</strong><span><i className={props.connected ? "connected" : ""} />{props.connected ? "Online" : "Reconnecting"}</span></div>
      </div>
      <div className="sidebarActions">
        {searchOpen ? (
          <div className="sessionSearch">
            <span className="sessionSearchIcon" aria-hidden="true"><SearchIcon /></span>
            <Input
              autoFocus
              aria-label="Filter sessions"
              placeholder="Filter sessions…"
              value={props.filter}
              onChange={(event) => props.onFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeSearch();
              }}
            />
            <Button className="sessionSearchClose" aria-label="Close session search" onClick={closeSearch}><span aria-hidden="true">×</span></Button>
          </div>
        ) : (
          <>
            <Button className="newSessionButton" onClick={props.onCreate}><span aria-hidden="true">＋</span> New session</Button>
            <TipButton className="sessionSearchButton" label="Search sessions" onClick={() => setSearchExpanded(true)}><SearchIcon /></TipButton>
          </>
        )}
      </div>
      <div className="sessionList">
        <p className="sectionLabel">Recent work <span>{props.sessions.length}</span></p>
        {props.sessions.map((session) => (
          <Button key={session.id} className={`sessionCard ${session.id === props.currentId ? "active" : ""}`} onClick={() => props.onOpen(session.id)}>
            <span className="sessionCardTitle">{session.name || session.firstMessage || "Untitled session"}</span>
            <span className="sessionCardMeta"><span>{compactPath(session.cwd)}</span><time>{formatModified(session.modified)}</time></span>
          </Button>
        ))}
        {!props.sessions.length && <p className="noSessions">No matching sessions.</p>}
      </div>
    </div>
  );
}

function PiMark({ className }: { className: string }): ReactNode {
  return <img className={`piMark ${className}`} src="/icon.svg?v=cool-slate" alt="" aria-hidden="true" />;
}

function Composer(props: {
  current: SessionSnapshot | undefined;
  status: SessionStatus;
  queue: { steering: readonly string[]; followUp: readonly string[] };
  draft: string;
  attachments: UploadedAttachment[];
  onDraft(value: string): void;
  onUpload(files: FileList | null): void;
  onRemoveAttachment(id: string): void;
  onSubmit(): void;
  onAbort(): void;
  onModel(model: { provider: string; id: string }): void;
  onThinking(thinking: ThinkingLevel): void;
}): ReactNode {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeCommand, setActiveCommand] = useState(0);
  const hasDraft = Boolean(props.draft.trim());
  const actionMode = props.status === "aborting" ? "stopping" : props.status === "running" && !hasDraft ? "stop" : "send";
  const actionLabel = props.status === "running" ? "Steer message" : "Send message";
  const queuedMessages = [
    ...props.queue.steering.map((text, index) => ({ id: `steer-${index}-${text}`, text, kind: "steer" as const })),
    ...props.queue.followUp.map((text, index) => ({ id: `follow-up-${index}-${text}`, text, kind: "followUp" as const })),
  ];
  const modelItems = useMemo(() => (props.current?.availableModels || []).map((model) => ({
    ...model,
    value: `${model.provider}/${model.id}`,
    label: model.name || `${model.provider}/${model.id}`,
  })), [props.current?.availableModels]);
  const selectedModel = modelItems.find((model) => model.provider === props.current?.model?.provider && model.id === props.current?.model?.id) || null;
  const commandQuery = slashCommandQuery(props.draft);
  const matchingCommands = useMemo(
    () => commandQuery === undefined ? [] : filterSlashCommands(props.current?.slashCommands || [], commandQuery),
    [commandQuery, props.current?.slashCommands],
  );
  const commandMenuOpen = Boolean(props.current && commandQuery !== undefined);
  useEffect(() => setActiveCommand(0), [commandQuery, props.current?.id]);

  const chooseCommand = (command: SlashCommand) => {
    props.onDraft(`/${command.name} `);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <section className="composerDock">
      <div className="composerPanel">
        {commandMenuOpen && (
          <div className="slashCommandMenu" role="listbox" aria-label="Slash commands" id="slash-command-menu">
            <div className="slashCommandHeader"><span>Pi commands</span><small>{matchingCommands.length}</small></div>
            <div className="slashCommandList">
              {matchingCommands.map((command, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeCommand}
                  className={`slashCommandItem ${index === activeCommand ? "active" : ""}`}
                  key={`${command.source}:${command.name}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveCommand(index)}
                  onClick={() => chooseCommand(command)}
                >
                  <span className="slashCommandName">/{highlightCommandMatch(command.name, commandQuery || "")}</span>
                  <span className="slashCommandDescription">{command.description || fallbackCommandDescription(command.source)}</span>
                  <small>{commandSourceLabel(command.source)}</small>
                </button>
              ))}
              {!matchingCommands.length && <p className="slashCommandEmpty">No matching Pi commands.</p>}
            </div>
            <div className="slashCommandHint"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>Tab</kbd> select</span><span><kbd>Esc</kbd> close</span></div>
          </div>
        )}
        {queuedMessages.length > 0 && <div className="messageQueue" role="list" aria-label="Queued messages">{queuedMessages.map((message) => <div className="queueMessage" role="listitem" key={message.id}><span className="queueMessageIcon" aria-hidden="true">↳</span><span className="queueMessageText">{message.text}</span><span className="queueMessageKind">{message.kind === "steer" ? "Steer" : "Queued"}</span></div>)}</div>}
        {props.attachments.length > 0 && <div className="attachmentList" aria-label="Attached images">{props.attachments.map((attachment) => <div className="attachmentPreview" key={attachment.id} title={attachment.name}><img src={attachment.previewUrl} alt={attachment.name} /><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => props.onRemoveAttachment(attachment.id)}>×</button></div>)}</div>}
        <textarea
          ref={textareaRef}
          value={props.draft}
          onChange={(event) => props.onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (commandMenuOpen) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (matchingCommands.length) setActiveCommand((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + matchingCommands.length) % matchingCommands.length);
                return;
              }
              if ((event.key === "Tab" || event.key === "Enter") && matchingCommands[activeCommand]) {
                event.preventDefault();
                chooseCommand(matchingCommands[activeCommand]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                props.onDraft(props.draft.slice(1));
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              props.onSubmit();
            }
          }}
          placeholder={props.current ? (props.status === "running" ? "Add direction while Pi works…" : "Describe what Pi should work on…") : "Create or open a session to begin"}
          disabled={!props.current}
          aria-label="Message Pi"
          aria-controls={commandMenuOpen ? "slash-command-menu" : undefined}
          aria-expanded={commandMenuOpen}
          aria-autocomplete="list"
        />
        <div className="composerActions">
          <label className="attachButton" title="Add images"><span aria-hidden="true">＋</span><span className="srOnly">Add images</span><input hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { void props.onUpload(event.target.files); event.target.value = ""; }} /></label>
          {props.current && <div className="composerControls">
            {modelItems.length > 0 && (
              <Combobox.Root
                items={modelItems}
                value={selectedModel}
                onValueChange={(model) => model && props.onModel(model)}
                isItemEqualToValue={(item, value) => item.value === value.value}
                itemToStringLabel={(item) => item.label}
              >
                <Combobox.Label className="srOnly">Model</Combobox.Label>
                <Combobox.Trigger className="controlButton modelControl"><ModelProviderIcon provider={selectedModel?.provider || props.current?.model?.provider} /><Combobox.Value placeholder="Choose model" /><Combobox.Icon className="selectorIcon"><ChevronIcon /></Combobox.Icon></Combobox.Trigger>
                <Combobox.Portal>
                  <Combobox.Positioner className="popupPositioner" side="top" sideOffset={8} align="end">
                    <Combobox.Popup className="comboboxPopup" aria-label="Choose model">
                      <Combobox.Input className="popupSearch" placeholder="Search models…" autoFocus />
                      <Combobox.Empty className="popupEmpty">No matching models.</Combobox.Empty>
                      <Combobox.List className="popupList">
                        {(model: (typeof modelItems)[number]) => <Combobox.Item key={model.value} value={model} className="popupItem"><Combobox.ItemIndicator>✓</Combobox.ItemIndicator><span>{model.label}</span><small>{model.provider}/{model.id}</small></Combobox.Item>}
                      </Combobox.List>
                    </Combobox.Popup>
                  </Combobox.Positioner>
                </Combobox.Portal>
              </Combobox.Root>
            )}
            <ControlSelect
              label="Thinking"
              icon={<BrainIcon />}
              value={props.current?.thinking || "medium"}
              items={["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: value }))}
              onChange={(value) => props.onThinking(value as ThinkingLevel)}
            />
          </div>}
          <Button
            className={`composerActionButton ${actionMode === "send" ? "send" : "stop"}`}
            disabled={actionMode === "stopping" || (actionMode === "send" && (!props.current || !hasDraft))}
            onClick={actionMode === "send" ? props.onSubmit : props.onAbort}
            aria-label={actionMode === "stopping" ? "Stopping" : actionMode === "stop" ? "Stop" : actionLabel}
          >
            {actionMode === "send" ? <span aria-hidden="true">↑</span> : <span aria-hidden="true">■</span>}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function slashCommandQuery(draft: string): string | undefined {
  if (!draft.startsWith("/") || draft.includes("\n")) return undefined;
  const query = draft.slice(1);
  return /\s/u.test(query) ? undefined : query.toLocaleLowerCase();
}

export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return commands;
  const score = (command: SlashCommand) => {
    const name = command.name.toLocaleLowerCase();
    if (name === normalized) return 0;
    if (name.startsWith(normalized)) return 1;
    if (name.includes(normalized)) return 2;
    return command.description?.toLocaleLowerCase().includes(normalized) ? 3 : 4;
  };
  return commands.filter((command) => score(command) < 4).sort((left, right) => score(left) - score(right));
}

function highlightCommandMatch(name: string, query: string): ReactNode {
  if (!query) return name;
  const index = name.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return name;
  return <>{name.slice(0, index)}<strong>{name.slice(index, index + query.length)}</strong>{name.slice(index + query.length)}</>;
}

function commandSourceLabel(source: SlashCommand["source"]): string {
  if (source === "extension") return "Extension";
  if (source === "prompt") return "Prompt";
  return "Skill";
}

function fallbackCommandDescription(source: SlashCommand["source"]): string {
  if (source === "extension") return "Run an extension command";
  if (source === "prompt") return "Use a reusable prompt";
  return "Load skill instructions";
}

function ControlSelect(props: { label: string; icon?: ReactNode; value: string; items: Array<{ value: string; label: string }>; onChange(value: string): void }): ReactNode {
  return (
    <Select.Root items={props.items} value={props.value} onValueChange={(value) => value && props.onChange(value)}>
      <Select.Label className="srOnly">{props.label}</Select.Label>
      <Select.Trigger className="controlButton">{props.icon && <span className="controlIcon" aria-hidden="true">{props.icon}</span>}<Select.Value /><Select.Icon className="selectorIcon"><ChevronIcon /></Select.Icon></Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="popupPositioner" side="top" sideOffset={8} align="start" alignItemWithTrigger={false}>
          <Select.Popup className="selectPopup"><Select.List className="popupList">{props.items.map((item) => <Select.Item key={item.value} value={item.value} className="popupItem"><Select.ItemIndicator>✓</Select.ItemIndicator><Select.ItemText>{item.label}</Select.ItemText></Select.Item>)}</Select.List></Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

function ChevronIcon(): ReactNode {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 12 12"><path d="m3 4.5 3 3 3-3" /></svg>;
}

function SearchIcon(): ReactNode {
  return <svg className="searchIcon" aria-hidden="true" focusable="false" viewBox="0 0 20 20"><circle cx="8.7" cy="8.7" r="5.2" /><path d="m12.6 12.6 4 4" /></svg>;
}

type ModelProviderKind = "openai" | "anthropic" | "google" | "xai" | "mistral" | "generic";

const MODEL_PROVIDER_ICON_URLS: Partial<Record<ModelProviderKind, string>> = {
  openai: openAiProviderIcon,
  anthropic: anthropicProviderIcon,
  google: geminiProviderIcon,
  xai: xAiProviderIcon,
  mistral: mistralProviderIcon,
};

function ModelProviderIcon({ provider }: { provider: string | undefined }): ReactNode {
  const kind = modelProviderKind(provider);
  const iconUrl = MODEL_PROVIDER_ICON_URLS[kind];
  return (
    <span className={`controlIcon modelIcon provider-${kind}`} data-provider={kind} aria-hidden="true">
      {iconUrl
        ? <span className="providerIconGlyph" style={{ WebkitMaskImage: `url("${iconUrl}")`, maskImage: `url("${iconUrl}")` }} />
        : <svg className="genericProviderIcon" viewBox="0 0 20 20" focusable="false"><path d="m10 2.5 6.5 3.8v7.4L10 17.5l-6.5-3.8V6.3L10 2.5Z" /><path d="M7 12.8V7.2l3 2.2 3-2.2v5.6" /></svg>}
    </span>
  );
}

export function modelProviderKind(provider?: string): ModelProviderKind {
  const normalized = provider?.toLocaleLowerCase() || "";
  if (normalized.includes("openai") || normalized.includes("codex")) return "openai";
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "anthropic";
  if (normalized.includes("google") || normalized.includes("gemini")) return "google";
  if (normalized.includes("xai") || normalized.includes("grok")) return "xai";
  if (normalized.includes("mistral")) return "mistral";
  return "generic";
}

function BrainIcon(): ReactNode {
  return (
    <svg className="brainIcon" viewBox="0 0 20 20" focusable="false">
      <path d="M9.6 3.5A2.8 2.8 0 0 0 4.8 5.4 2.8 2.8 0 0 0 3.4 10a2.9 2.9 0 0 0 2.2 4.7A2.7 2.7 0 0 0 9.6 17V3.5Z" />
      <path d="M10.4 3.5a2.8 2.8 0 0 1 4.8 1.9 2.8 2.8 0 0 1 1.4 4.6 2.9 2.9 0 0 1-2.2 4.7 2.7 2.7 0 0 1-4 2.3V3.5Z" />
      <path d="M5.7 7.1c1.2 0 2 .7 2.1 1.8M5.4 12.1c1.1-.2 2 .3 2.4 1.3M14.3 7.1c-1.2 0-2 .7-2.1 1.8M14.6 12.1c-1.1-.2-2 .3-2.4 1.3" />
    </svg>
  );
}

function InstallIcon(): ReactNode {
  return <svg className="menuItemIcon" aria-hidden="true" viewBox="0 0 20 20" focusable="false"><path d="M10 2.5v9m-3-3 3 3 3-3M4.5 12v4h11v-4" /></svg>;
}

function RenameIcon(): ReactNode {
  return <svg className="menuItemIcon" aria-hidden="true" viewBox="0 0 20 20" focusable="false"><path d="m4 14.8.5-3.1 7.8-7.8 2.6 2.6-7.8 7.8-3.1.5Z" /><path d="m11.3 4.9 2.6 2.6" /></svg>;
}

function ThemeIcon({ theme }: { theme: Theme }): ReactNode {
  return theme === "dark"
    ? <svg className="menuItemIcon" aria-hidden="true" viewBox="0 0 20 20" focusable="false"><circle cx="10" cy="10" r="3.2" /><path d="M10 2v2m0 12v2M2 10h2m12 0h2M4.3 4.3l1.4 1.4m8.6 8.6 1.4 1.4m0-11.4-1.4 1.4m-8.6 8.6-1.4 1.4" /></svg>
    : <svg className="menuItemIcon" aria-hidden="true" viewBox="0 0 20 20" focusable="false"><path d="M15.7 12.6A6.3 6.3 0 0 1 7.4 4.3 6.3 6.3 0 1 0 15.7 12.6Z" /></svg>;
}

export function buildTimelineRows(timeline: unknown[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let activity: ToolActivity[] = [];
  let activityById = new Map<string, ToolActivity>();

  const flushActivity = () => {
    if (!activity.length) return;
    rows.push({ kind: "activity", tools: activity, key: `activity-${rows.length}-${activity[0]?.id || "tools"}` });
    activity = [];
    activityById = new Map();
  };
  const upsertTool = (tool: ToolActivity) => {
    const current = activityById.get(tool.id);
    if (current) Object.assign(current, tool, { args: tool.args ?? current.args, result: tool.result ?? current.result });
    else {
      activity.push(tool);
      activityById.set(tool.id, tool);
    }
  };

  timeline.forEach((item, index) => {
    const record = asRecord(item);
    const nested = asRecord(record?.message) || record;
    const role = String(nested?.role || "event");
    const content = Array.isArray(nested?.content) ? nested.content : [];
    const toolCalls = role === "assistant" ? content.map(asRecord).filter((part) => part?.type === "toolCall") : [];

    if (toolCalls.length) {
      const visibleContent = content.filter((part) => {
        const value = asRecord(part);
        if (value?.type === "toolCall") return false;
        if (value?.type === "thinking") return Boolean(String(value.thinking || value.text || "").trim());
        return true;
      });
      if (visibleContent.length) {
        flushActivity();
        const visibleMessage = { ...nested, content: visibleContent };
        rows.push({ kind: "item", item: record?.message ? { ...record, message: visibleMessage } : visibleMessage, key: `item-${index}` });
      }
      for (const [callIndex, call] of toolCalls.entries()) {
        const id = String(call?.id || call?.toolCallId || `call-${index}-${callIndex}`);
        upsertTool({ id, name: String(call?.name || call?.toolName || "tool"), args: call?.arguments || call?.args, status: "queued" });
      }
      return;
    }

    if (role === "toolResult") {
      const id = String(nested?.toolCallId || `result-${index}`);
      upsertTool({
        id,
        name: String(nested?.toolName || activityById.get(id)?.name || "tool"),
        result: { content: nested?.content, details: nested?.details },
        status: nested?.isError ? "error" : "complete",
      });
      return;
    }

    const eventType = String(record?.type || "event");
    if (eventType.startsWith("tool_execution_")) {
      const id = String(record?.toolCallId || `event-${index}`);
      const stage = eventType.replace("tool_execution_", "");
      upsertTool({
        id,
        name: String(record?.toolName || activityById.get(id)?.name || "tool"),
        args: record?.args,
        result: record?.result || record?.partialResult,
        status: stage === "end" ? (record?.isError ? "error" : "complete") : "running",
      });
      return;
    }

    flushActivity();
    rows.push({ kind: "item", item, key: `item-${index}` });
  });
  flushActivity();
  return rows;
}

function ToolActivityGroup({ tools }: { tools: ToolActivity[] }): ReactNode {
  const running = tools.some((tool) => tool.status === "running" || tool.status === "queued");
  const failed = tools.some((tool) => tool.status === "error");
  return (
    <div className={`activityGroup ${running ? "running" : failed ? "error" : "complete"}`} role="group" aria-label={`${tools.length} tool ${tools.length === 1 ? "call" : "calls"}`}>
      {tools.map((tool) => <ToolActivityRow key={tool.id} tool={tool} />)}
    </div>
  );
}

function ToolActivityRow({ tool }: { tool: ToolActivity }): ReactNode {
  const title = toolArgsTitle(tool.args);
  const summary = title ? "" : summarizeToolArgs(tool.args);
  return (
    <Collapsible.Root className={`activityItem ${tool.status}`}>
      <Collapsible.Trigger className="activityItemTrigger">
        <ToolActivityIcon name={tool.name} />
        <strong>{title || toolActivityLabel(tool)}</strong>
        {summary && <span className="activityItemSummary">{compactToolSummary(tool.name, summary)}</span>}
        {(tool.status === "running" || tool.status === "queued" || tool.status === "error") && <small className="activityItemStatus">{tool.status}</small>}
        <span className="activityItemChevron" aria-hidden="true"><ChevronIcon /></span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="activityItemPanel">
        {tool.args !== undefined && <ToolPayload label="Input" value={tool.args} />}
        {tool.result !== undefined && <ToolPayload label="Output" value={tool.result} />}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function ToolActivityIcon({ name }: { name: string }): ReactNode {
  const kind = toolKind(name);
  return <span className={`activityItemIcon ${kind}`} aria-hidden="true">{kind === "terminal"
    ? <svg viewBox="0 0 18 18"><rect x="2.2" y="3" width="13.6" height="12" rx="2.5" /><path d="m5.2 7 2 2-2 2m4.4 0h3" /></svg>
    : kind === "edit"
      ? <svg viewBox="0 0 18 18"><path d="m3.4 12.8-.4 2.3 2.3-.4 8.4-8.4-1.9-1.9-8.4 8.4Z" /><path d="m10.8 5.4 1.9 1.9" /></svg>
      : kind === "read"
        ? <svg viewBox="0 0 18 18"><path d="M4 2.8h6.3L14 6.5v8.7H4Z" /><path d="M10 2.8v4h4M6.5 10h5M6.5 12.5h4" /></svg>
        : kind === "browser"
          ? <svg viewBox="0 0 18 18"><rect x="2.2" y="2.8" width="13.6" height="11.4" rx="2.5" /><path d="M2.8 6h12.4m-8.3 3.1 5.1 2.1-2.1.8-.8 2.1-2.2-5Z" /></svg>
          : <svg viewBox="0 0 18 18"><rect x="2.5" y="2.5" width="13" height="13" rx="3" /><path d="M6 9h6M9 6v6" /></svg>}</span>;
}

function toolKind(name: string): "terminal" | "edit" | "read" | "browser" | "generic" {
  const normalized = name.toLocaleLowerCase();
  if (/bash|shell|terminal|exec|command/u.test(normalized)) return "terminal";
  if (/write|edit|patch|replace/u.test(normalized)) return "edit";
  if (/read|find|search|grep/u.test(normalized)) return "read";
  if (/browser|chrome|computer|playwright|screenshot|click/u.test(normalized)) return "browser";
  return "generic";
}

function toolActivityLabel(tool: ToolActivity): string {
  const active = tool.status === "running" || tool.status === "queued";
  switch (toolKind(tool.name)) {
    case "terminal": return active ? "Running" : "Ran";
    case "edit": return active ? "Editing" : "Edited";
    case "read": return active ? "Reading" : "Read";
    case "browser": return active ? "Inspecting" : "Inspected";
    default: return `${active ? "Running" : "Ran"} ${tool.name}`;
  }
}

function toolArgsTitle(value: unknown): string | undefined {
  const title = asRecord(value)?.title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

function compactToolSummary(name: string, summary: string): string {
  if (!["edit", "read"].includes(toolKind(name))) return summary;
  const normalized = summary.replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) || summary;
}

function ToolPayload({ label, value }: { label: string; value: unknown }): ReactNode {
  const record = asRecord(value);
  const content = record?.content;
  const rest = record ? Object.fromEntries(Object.entries(record).filter(([key, item]) => key !== "content" && hasPayload(item))) : undefined;
  return <section className="toolPayload"><h4>{label}</h4>{content !== undefined && <div className="toolPayloadContent">{renderContent(content)}</div>}{(!record || Object.keys(rest || {}).length > 0) && <pre>{formatPayload(record ? rest : value)}</pre>}</section>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function summarizeToolArgs(value: unknown): string {
  const candidate = findSummaryValue(value);
  if (candidate === undefined) return "";
  const singleLine = String(candidate).replace(/\s+/gu, " ").trim();
  return singleLine.length > 90 ? `${singleLine.slice(0, 87)}…` : singleLine;
}

function findSummaryValue(value: unknown): string | number | boolean | undefined {
  if (["string", "number", "boolean"].includes(typeof value)) return value as string | number | boolean;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSummaryValue(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const preferred = ["path", "command", "pattern", "query", "type", "name", "url", "action"];
  for (const key of preferred) {
    if (!(key in record)) continue;
    const found = findSummaryValue(record[key]);
    if (found !== undefined) return found;
  }
  for (const item of Object.values(record)) {
    const found = findSummaryValue(item);
    if (found !== undefined) return found;
  }
  return undefined;
}

function hasPayload(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  const record = asRecord(value);
  return record ? Object.keys(record).length > 0 : true;
}

function formatPayload(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) || "";
}

function TimelineItem({ item }: { item: unknown }): ReactNode {
  const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
  const nested = record?.message && typeof record.message === "object" ? record.message as Record<string, unknown> : record;
  const role = String(nested?.role || "event");
  if (role === "user" || role === "assistant") {
    const live = Boolean(record?.__live);
    return <article className={`message ${role} ${live ? "live" : ""}`}>{role === "assistant" && <div className="assistantLabel"><PiMark className="assistantMark" /> Pi</div>}<div className="messageContent">{renderContent(nested?.content, { markdown: role === "assistant", streaming: live })}</div>{live && <span className="streamCursor" />}</article>;
  }
  const eventType = String(record?.type || "event");
  if (["message_start", "message_update", "message_end", "turn_start", "turn_end", "agent_start", "agent_end", "agent_settled", "entry_appended"].includes(eventType)) return null;
  const result = record?.result && typeof record.result === "object" ? record.result as Record<string, unknown> : undefined;
  return (
    <Collapsible.Root className="toolEvent">
      <Collapsible.Trigger className="toolTrigger"><span>{eventType.replaceAll("_", " ")}</span><small>details</small><b>⌄</b></Collapsible.Trigger>
      <Collapsible.Panel className="toolPanel">{result?.content ? <div>{renderContent(result.content)}</div> : null}<pre>{JSON.stringify(record?.args || record?.partialResult || (result ? { ...result, content: undefined } : item), null, 2)}</pre></Collapsible.Panel>
    </Collapsible.Root>
  );
}

function renderContent(content: unknown, options: { markdown?: boolean; streaming?: boolean } = {}): ReactNode {
  if (typeof content === "string") return options.markdown ? <MarkdownText text={content} streaming={options.streaming} /> : content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  const rendered: ReactNode[] = [];
  let markdown = "";
  const flushMarkdown = (key: number) => {
    if (!markdown) return;
    rendered.push(<MarkdownText key={`markdown-${key}`} text={markdown} streaming={options.streaming} />);
    markdown = "";
  };
  content.forEach((part, index) => {
    if (!part || typeof part !== "object") {
      flushMarkdown(index);
      rendered.push(<span key={index}>{String(part)}</span>);
      return;
    }
    const value = part as Record<string, unknown>;
    if ((value.type === "text" || value.type === "thinking") && options.markdown) {
      markdown += String(value.text || value.thinking || "");
      return;
    }
    flushMarkdown(index);
    if (value.type === "text" || value.type === "thinking") rendered.push(<span key={index}>{String(value.text || value.thinking || "")}</span>);
    else if (value.type === "image" && typeof value.data === "string") rendered.push(<img key={index} className="resultImage" alt="Computer screenshot" src={`data:${String(value.mimeType || "image/png")};base64,${value.data}`} />);
    else rendered.push(<pre className="inlineData" key={index}>{JSON.stringify(value, null, 2)}</pre>);
  });
  flushMarkdown(content.length);
  return rendered;
}

function MarkdownText({ text, streaming = false }: { text: string; streaming?: boolean | undefined }): ReactNode {
  return <Suspense fallback={<span className="markdownFallback">{text}</span>}><StreamdownRenderer className="markdownBody" mode={streaming ? "streaming" : "static"} isAnimating={streaming} animated={streaming} controls={false} lineNumbers={false}>{text}</StreamdownRenderer></Suspense>;
}

function EmptyState({ connected, hasSession, onCreate }: { connected: boolean; hasSession: boolean; onCreate(): void }): ReactNode {
  if (hasSession) {
    return <div className="emptyState"><PiMark className="emptyMark" /><p className="eyebrow">Ready for a task</p><h2>What should Pi work on?</h2><p>Describe the outcome you want below. You can add images and adjust the model’s thinking level before sending.</p></div>;
  }
  return <div className="emptyState"><PiMark className="emptyMark" /><p className="eyebrow">{connected ? "Agent online" : "Connecting"}</p><h2>Put Pi to work from anywhere.</h2><p>Start a persistent coding session, leave the app, and get notified when the result is ready.</p><Button className="primaryButton" onClick={onCreate}>Create your first session</Button></div>;
}

function AppDialog(props: { open: boolean; onOpenChange(open: boolean): void; title: string; description: string; popupClassName?: string; children: ReactNode }): ReactNode {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialogBackdrop" />
        <Dialog.Viewport className="dialogViewport">
          <Dialog.Popup className={`dialogPopup ${props.popupClassName || ""}`}>
            <Dialog.Close className="dialogClose" aria-label="Close">×</Dialog.Close>
            <Dialog.Title className="dialogTitle">{props.title}</Dialog.Title>
            <Dialog.Description className="dialogDescription">{props.description}</Dialog.Description>
            {props.children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function InstallGuidance({ installed, promptEvent, onPromptUsed, onInstalled, showError }: {
  installed: boolean;
  promptEvent: BeforeInstallPromptEvent | null;
  onPromptUsed(): void;
  onInstalled(): void;
  showError(message: string): void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const ios = isIosDevice();

  const install = async () => {
    if (!promptEvent) return;
    setBusy(true);
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      onPromptUsed();
      if (choice.outcome === "accepted") onInstalled();
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (installed) {
    return <div className="installState installed"><span>✓</span><div><strong>Pi is on your Home Screen</strong><p>Open it from your device like any other app.</p></div></div>;
  }

  return (
    <div className="installGuidance">
      <div className="installState"><span>＋</span><div><strong>{promptEvent ? "Install Pi on this device" : "Keep Pi one tap away"}</strong><p>{promptEvent ? "Your browser can add Pi as an app now." : ios ? "Use your browser’s Share menu to add Pi to your Home Screen." : "Use your browser’s menu to install Pi or add it to your Home Screen."}</p></div></div>
      {promptEvent ? (
        <Button className="primaryButton fullWidth" disabled={busy} onClick={() => void install()}>{busy ? "Opening install prompt…" : "Install Pi"}</Button>
      ) : (
        <ol className="installSteps">
          {ios ? <><li>Tap the <strong>Share</strong> button in your browser.</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Tap <strong>Add</strong> to confirm.</li></> : <><li>Open your browser’s menu.</li><li>Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li><li>Follow the confirmation prompt.</li></>}
        </ol>
      )}
    </div>
  );
}

type PushUiState = "checking" | "unsupported" | "unavailable" | "install-required" | "denied" | "disabled" | "enabled";

export function NotificationSettings({ publicKey, showError }: { publicKey: string | undefined; showError(message: string): void }): ReactNode {
  const [status, setStatus] = useState<PushUiState>("checking");
  const [busy, setBusy] = useState(false);

  const getRegistration = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return undefined;
    return navigator.serviceWorker.ready;
  }, []);

  const syncState = useCallback(async () => {
    if (!publicKey) {
      setStatus("unavailable");
      return;
    }
    if (isIosDevice() && !isStandalone()) {
      setStatus("install-required");
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setStatus("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    const registration = await getRegistration();
    if (!registration) return setStatus("unsupported");
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return setStatus("disabled");
    if (!subscriptionMatchesKey(subscription, publicKey)) {
      await removeSubscription(subscription);
      setStatus("disabled");
      return;
    }
    const response = await fetch("/api/push/subscription", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!response.ok) throw new Error(await responseError(response, "Unable to synchronize notifications"));
    setStatus("enabled");
  }, [getRegistration, publicKey]);

  useEffect(() => {
    void syncState().catch((error) => {
      setStatus("disabled");
      showError(error instanceof Error ? error.message : String(error));
    });
  }, [showError, syncState]);

  const enable = async () => {
    setBusy(true);
    try {
      if (!publicKey) throw new Error("Notification settings are unavailable until Pi Daemon restarts");
      if (Notification.permission !== "granted") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setStatus(permission === "denied" ? "denied" : "disabled");
          return;
        }
      }
      const registration = await getRegistration();
      if (!registration) throw new Error("Push notifications are not supported by this browser");
      let subscription = await registration.pushManager.getSubscription();
      if (subscription && !subscriptionMatchesKey(subscription, publicKey)) {
        await removeSubscription(subscription);
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeApplicationServerKey(publicKey) });
      const response = await fetch("/api/push/subscription", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) throw new Error(await responseError(response, "Unable to enable notifications"));
      setStatus("enabled");
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const registration = await getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) await removeSubscription(subscription);
      setStatus("disabled");
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const copy: Record<PushUiState, { title: string; body: string }> = {
    checking: { title: "Checking this device", body: "Looking for an existing notification subscription." },
    unsupported: { title: "Not supported here", body: "This browser does not provide the Service Worker and Push APIs required for background alerts." },
    unavailable: { title: "Restart Pi Daemon", body: "The notification service has not finished updating. Run pi-daemon restart all on the host, then reopen this app." },
    "install-required": { title: "Add Pi to your Home Screen", body: "On iPhone and iPad, open this site in your browser, choose Add to Home Screen, then enable notifications from the installed app." },
    denied: { title: "Permission is blocked", body: "Allow notifications for Pi Daemon in your browser or device settings, then return here." },
    disabled: { title: "Notifications are off", body: "Enable them to receive a lock-screen preview when a session completes or fails." },
    enabled: { title: "Notifications are on", body: "This device will receive final-response previews. You can disable them here at any time." },
  };
  return (
    <div className="notificationSettings">
      <div className={`notificationState ${status}`}><span>{status === "enabled" ? "✓" : status === "denied" || status === "unsupported" || status === "unavailable" ? "!" : "◎"}</span><div><strong>{copy[status].title}</strong><p>{copy[status].body}</p></div></div>
      <p className="privacyNote"><strong>Lock-screen privacy:</strong> completion alerts include up to 160 characters of Pi’s final response; failures include the error message.</p>
      {status === "enabled" && <Button className="secondaryButton fullWidth" disabled={busy} onClick={() => void disable()}>{busy ? "Disabling…" : "Disable on this device"}</Button>}
      {status === "disabled" && <Button className="primaryButton fullWidth" disabled={busy} onClick={() => void enable()}>{busy ? "Enabling…" : "Enable notifications"}</Button>}
    </div>
  );
}

async function removeSubscription(subscription: PushSubscription): Promise<void> {
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await fetch("/api/push/subscription", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

export function decodeApplicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replaceAll("-", "+").replaceAll("_", "/"));
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function subscriptionMatchesKey(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options.applicationServerKey;
  if (!key) return false;
  const bytes = new Uint8Array(key);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "") === publicKey;
}

function isIosDevice(): boolean {
  return /iPad|iPhone|iPod/u.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

function initialTheme(): Theme {
  const stored = window.localStorage.getItem("pi-daemon-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

async function responseError(response: Response, fallback: string): Promise<string> {
  const value = await response.json().catch(() => undefined) as { error?: string } | undefined;
  return value?.error || `${fallback} (${response.status})`;
}

function TipButton(props: { label: string; className: string; onClick(): void; children: ReactNode }): ReactNode {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={<Button className={props.className} onClick={props.onClick} aria-label={props.label} />}>{props.children}</Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Positioner sideOffset={8}><Tooltip.Popup className="tooltipPopup">{props.label}</Tooltip.Popup></Tooltip.Positioner></Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function ToastViewport(): ReactNode {
  const { toasts } = Toast.useToastManager();
  return <Toast.Portal><Toast.Viewport className="toastViewport">{toasts.map((toast) => <Toast.Root key={toast.id} toast={toast} className="toastRoot"><Toast.Content className="toastContent"><div><Toast.Title className="toastTitle" /><Toast.Description className="toastDescription" /></div><Toast.Close className="toastClose" aria-label="Dismiss">×</Toast.Close></Toast.Content></Toast.Root>)}</Toast.Viewport></Toast.Portal>;
}

function compactPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function formatModified(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

const root = document.getElementById("root");
if (root) {
  installTouchZoomGuard(document, navigator.maxTouchPoints);
  createRoot(root).render(
    <StrictMode>
      <Tooltip.Provider>
        <Toast.Provider limit={3}>
          <PiDaemonApp />
          <ToastViewport />
        </Toast.Provider>
      </Tooltip.Provider>
    </StrictMode>,
  );
}

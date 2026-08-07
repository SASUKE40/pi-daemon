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
import type { ClientCommand, ServerEvent, SessionSnapshot, SessionSummary, ThinkingLevel } from "../src/protocol.ts";
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
}

type SessionStatus = "idle" | "running" | "aborting" | "error";

interface AppState {
  connected: boolean;
  daemonConnected: boolean;
  sessions: SessionSummary[];
  current?: SessionSnapshot;
  timeline: unknown[];
  status: SessionStatus;
}

type AppAction =
  | { type: "socket.open" }
  | { type: "socket.close" }
  | { type: "daemon.ready" }
  | { type: "session.list"; sessions: SessionSummary[] }
  | { type: "session.snapshot"; session: SessionSnapshot }
  | { type: "session.event"; value: unknown }
  | { type: "session.status"; status: SessionStatus };

const initialState: AppState = {
  connected: false,
  daemonConnected: false,
  sessions: [],
  timeline: [],
  status: "idle",
};

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
    };
    case "session.event": return { ...state, timeline: applyAgentEvent(state.timeline, action.value) };
    case "session.status": return { ...state, status: action.status };
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
  const [delivery, setDelivery] = useState<"steer" | "followUp">("followUp");
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => isStandalone());
  const [newSessionCwd, setNewSessionCwd] = useState("");
  const [newSessionName, setNewSessionName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [nearBottom, setNearBottom] = useState(true);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const reconnectRef = useRef<number | undefined>(undefined);
  const daemonUnavailableRef = useRef(false);
  const stateRef = useRef(state);
  const preferredSessionRef = useRef<string | null>(new URL(window.location.href).searchParams.get("session"));
  const timelineRef = useRef<HTMLElement>(null);
  const toasts = Toast.useToastManager();
  const toastRef = useRef(toasts);
  stateRef.current = state;
  toastRef.current = toasts;

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
    const type = state.status === "running" ? `session.${delivery}` : "session.prompt";
    send({
      type,
      sessionId: state.current.id,
      text,
      attachments: attachments.map(({ id, mimeType }) => ({ id, mimeType })),
    });
    setDraft("");
    setAttachments([]);
    setNearBottom(true);
  };

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const form = new FormData();
    for (const file of files) form.append("image", file);
    try {
      const response = await fetch("/api/attachments", { method: "POST", body: form });
      const result = await response.json() as { attachments?: UploadedAttachment[]; error?: string };
      if (!response.ok) throw new Error(result.error || "Upload failed");
      setAttachments((current) => [...current, ...(result.attachments || [])]);
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
  };

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
            <TipButton className={`iconButton installButton ${installOpen ? "active" : ""}`} label="Add to Home Screen" onClick={() => setInstallOpen(true)}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5" /></svg>
            </TipButton>
            {state.current && (
              <Menu.Root>
                <Menu.Trigger className="iconButton" aria-label="Session actions">•••</Menu.Trigger>
                <Menu.Portal>
                  <Menu.Positioner className="popupPositioner" sideOffset={8} align="end">
                    <Menu.Popup className="menuPopup">
                      <Menu.Item className="menuItem" onClick={() => { setRenameValue(state.current?.name || ""); setRenameOpen(true); }}>Rename session</Menu.Item>
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
            )}
            <span className={`runPill ${state.status}`}>{state.status}</span>
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
            {state.timeline.length ? state.timeline.map((item, index) => <TimelineItem key={index} item={item} />) : <EmptyState connected={state.connected} hasSession={Boolean(state.current)} onCreate={() => setNewSessionOpen(true)} />}
          </div>
        </section>

        {!nearBottom && <Button className="jumpButton" onClick={() => { setNearBottom(true); timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: "smooth" }); }}>Jump to latest ↓</Button>}

        <Composer
          current={state.current}
          status={state.status}
          draft={draft}
          delivery={delivery}
          attachments={attachments}
          onDraft={setDraft}
          onDelivery={setDelivery}
          onUpload={upload}
          onRemoveAttachment={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
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
  return (
    <div className="sidebarContent">
      <div className="brandRow">
        <span className="brandMark">π</span>
        <div><strong>Pi Daemon</strong><span><i className={props.connected ? "connected" : ""} />{props.connected ? "Online" : "Reconnecting"}</span></div>
      </div>
      <Button className="newSessionButton" onClick={props.onCreate}><span>＋</span> New session</Button>
      <div className="sessionSearch"><Input aria-label="Filter sessions" placeholder="Filter sessions…" value={props.filter} onChange={(event) => props.onFilter(event.target.value)} /></div>
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

function Composer(props: {
  current: SessionSnapshot | undefined;
  status: SessionStatus;
  draft: string;
  delivery: "steer" | "followUp";
  attachments: UploadedAttachment[];
  onDraft(value: string): void;
  onDelivery(value: "steer" | "followUp"): void;
  onUpload(files: FileList | null): void;
  onRemoveAttachment(id: string): void;
  onSubmit(): void;
  onAbort(): void;
  onModel(model: { provider: string; id: string }): void;
  onThinking(thinking: ThinkingLevel): void;
}): ReactNode {
  const runActive = props.status === "running" || props.status === "aborting";
  const modelItems = useMemo(() => (props.current?.availableModels || []).map((model) => ({
    ...model,
    value: `${model.provider}/${model.id}`,
    label: model.name || `${model.provider}/${model.id}`,
  })), [props.current?.availableModels]);
  const selectedModel = modelItems.find((model) => model.provider === props.current?.model?.provider && model.id === props.current?.model?.id) || null;
  return (
    <section className="composerDock">
      <div className="composerPanel">
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
              <Combobox.Trigger className="controlButton"><Combobox.Value placeholder="Choose model" /><Combobox.Icon>⌄</Combobox.Icon></Combobox.Trigger>
              <Combobox.Portal>
                <Combobox.Positioner className="popupPositioner" side="top" sideOffset={8} align="start">
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
            value={props.current?.thinking || "medium"}
            items={["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, label: `Think: ${value}` }))}
            onChange={(value) => props.onThinking(value as ThinkingLevel)}
          />
          {props.status === "running" && <ControlSelect label="Message delivery" value={props.delivery} items={[{ value: "followUp", label: "Follow up" }, { value: "steer", label: "Steer now" }]} onChange={(value) => props.onDelivery(value as "steer" | "followUp")} />}
        </div>}
        {props.attachments.length > 0 && <div className="attachmentList">{props.attachments.map((attachment) => <span className="attachmentChip" key={attachment.id}>{attachment.name}<button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => props.onRemoveAttachment(attachment.id)}>×</button></span>)}</div>}
        <textarea
          value={props.draft}
          onChange={(event) => props.onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              props.onSubmit();
            }
          }}
          placeholder={props.current ? (props.status === "running" ? "Add direction while Pi works…" : "Describe what Pi should work on…") : "Create or open a session to begin"}
          disabled={!props.current}
          aria-label="Message Pi"
        />
        <div className="composerActions">
          <label className="attachButton">＋ <span>Add images</span><input hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => { void props.onUpload(event.target.files); event.target.value = ""; }} /></label>
          <span className="composerHint">Enter to send · Shift+Enter for a new line</span>
          <Button
            className={`composerActionButton ${runActive ? "stop" : "send"}`}
            disabled={runActive ? props.status === "aborting" : !props.current || !props.draft.trim()}
            onClick={runActive ? props.onAbort : props.onSubmit}
            aria-label={runActive ? (props.status === "aborting" ? "Stopping" : "Stop") : "Send message"}
          >
            {runActive ? <span aria-hidden="true">■</span> : <span aria-hidden="true">↑</span>}
          </Button>
        </div>
      </div>
    </section>
  );
}

function ControlSelect(props: { label: string; value: string; items: Array<{ value: string; label: string }>; onChange(value: string): void }): ReactNode {
  return (
    <Select.Root items={props.items} value={props.value} onValueChange={(value) => value && props.onChange(value)}>
      <Select.Label className="srOnly">{props.label}</Select.Label>
      <Select.Trigger className="controlButton"><Select.Value /><Select.Icon>⌄</Select.Icon></Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="popupPositioner" side="top" sideOffset={8} align="start" alignItemWithTrigger={false}>
          <Select.Popup className="selectPopup"><Select.List>{props.items.map((item) => <Select.Item key={item.value} value={item.value} className="popupItem"><Select.ItemIndicator>✓</Select.ItemIndicator><Select.ItemText>{item.label}</Select.ItemText></Select.Item>)}</Select.List></Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

function TimelineItem({ item }: { item: unknown }): ReactNode {
  const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
  const nested = record?.message && typeof record.message === "object" ? record.message as Record<string, unknown> : record;
  const role = String(nested?.role || "event");
  if (role === "user" || role === "assistant") {
    const live = Boolean(record?.__live);
    return <article className={`message ${role} ${live ? "live" : ""}`}>{role === "assistant" && <div className="assistantLabel"><span>π</span> Pi</div>}<div className="messageContent">{renderContent(nested?.content, { markdown: role === "assistant", streaming: live })}</div>{live && <span className="streamCursor" />}</article>;
  }
  const eventType = String(record?.type || "event");
  if (["message_start", "message_update", "message_end", "turn_start", "turn_end", "agent_start", "agent_end", "agent_settled", "entry_appended"].includes(eventType)) return null;
  const isTool = eventType.startsWith("tool_execution_");
  const result = record?.result && typeof record.result === "object" ? record.result as Record<string, unknown> : undefined;
  return (
    <Collapsible.Root className="toolEvent" defaultOpen={eventType === "tool_execution_end" && Boolean(result?.content)}>
      <Collapsible.Trigger className="toolTrigger"><span>{isTool ? String(record?.toolName || "tool") : eventType.replaceAll("_", " ")}</span><small>{isTool ? eventType.replace("tool_execution_", "") : "details"}</small><b>⌄</b></Collapsible.Trigger>
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
    if (value.type === "text" && options.markdown) {
      markdown += String(value.text || "");
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
    return <div className="emptyState"><span className="emptyMark">π</span><p className="eyebrow">Ready for a task</p><h2>What should Pi work on?</h2><p>Describe the outcome you want below. You can add images and adjust the model’s thinking level before sending.</p></div>;
  }
  return <div className="emptyState"><span className="emptyMark">π</span><p className="eyebrow">{connected ? "Agent online" : "Connecting"}</p><h2>Put Pi to work from anywhere.</h2><p>Start a persistent coding session, leave the app, and get notified when the result is ready.</p><Button className="primaryButton" onClick={onCreate}>Create your first session</Button></div>;
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

import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import type { ClientCommand, ServerEvent, SessionSnapshot, SessionSummary, ThinkingLevel } from "../src/protocol.ts";

interface Bootstrap {
  protocolVersion: 1;
  version: string;
  defaultCwd: string;
  hostname?: string;
  local: boolean;
}

class PiDaemonApp extends LitElement {
  static properties = {
    connected: { state: true },
    daemonConnected: { state: true },
    sessions: { state: true },
    current: { state: true },
    timeline: { state: true },
    status: { state: true },
    error: { state: true },
    sidebarOpen: { state: true },
    draft: { state: true },
    cwd: { state: true },
    delivery: { state: true },
    attachmentIds: { state: true },
  };

  static styles = css`
    :host { color-scheme: dark; --bg:#111315; --panel:#181b1e; --raised:#22262a; --line:#30363b; --text:#f4f2ed; --muted:#9ca3a9; --accent:#f1a54b; display:block; min-height:100dvh; background:var(--bg); color:var(--text); font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif; }
    * { box-sizing:border-box; }
    button,input,textarea,select { font:inherit; color:inherit; }
    button { border:0; cursor:pointer; }
    .shell { display:grid; grid-template-columns:310px 1fr; height:100dvh; overflow:hidden; }
    aside { background:var(--panel); border-right:1px solid var(--line); display:flex; flex-direction:column; min-width:0; }
    .brand { display:flex; align-items:center; gap:10px; padding:18px; border-bottom:1px solid var(--line); }
    .mark { display:grid; place-items:center; width:34px; height:34px; border-radius:11px; color:#111; background:var(--accent); font-weight:900; }
    .brand h1 { font-size:16px; margin:0; letter-spacing:.02em; }
    .connection { margin-left:auto; width:9px; height:9px; border-radius:50%; background:#d85858; box-shadow:0 0 0 4px #d8585822; }
    .connection.on { background:#61c981; box-shadow:0 0 0 4px #61c98122; }
    .new { margin:14px; padding:11px 14px; border-radius:10px; background:var(--accent); color:#17120b; font-weight:750; }
    .sessions { overflow:auto; padding:0 8px 20px; }
    .session { width:100%; text-align:left; padding:12px; border-radius:10px; background:transparent; margin:2px 0; }
    .session:hover,.session.active { background:var(--raised); }
    .session strong,.session small { display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    .session strong { font-size:14px; }
    .session small { color:var(--muted); margin-top:4px; }
    main { min-width:0; width:100%; display:grid; grid-template-rows:auto 1fr auto; }
    header { min-height:64px; padding:10px 18px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; background:#111315e8; backdrop-filter:blur(16px); }
    header .title { min-width:0; flex:1; }
    header strong,header small { display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
    header small { color:var(--muted); margin-top:2px; }
    .hamburger { display:none; background:var(--raised); padding:9px; border-radius:9px; }
    .status { padding:6px 9px; border-radius:999px; background:var(--raised); color:var(--muted); font-size:12px; }
    .status.running { background:#f1a54b22; color:#ffc87d; }
    .timeline { overflow:auto; padding:24px max(18px,calc((100% - 850px)/2)); scroll-behavior:smooth; }
    .empty { height:100%; display:grid; place-items:center; color:var(--muted); text-align:center; line-height:1.6; }
    .message { margin:0 0 18px; max-width:88%; }
    .message.user { margin-left:auto; background:var(--accent); color:#17120b; padding:12px 14px; border-radius:16px 16px 4px 16px; white-space:pre-wrap; }
    .message.assistant { line-height:1.55; white-space:pre-wrap; }
    .message .label { text-transform:uppercase; letter-spacing:.08em; font-size:10px; color:var(--muted); margin-bottom:6px; }
    .tool { border:1px solid var(--line); background:var(--panel); border-radius:12px; padding:10px 12px; margin:10px 0; font-family:ui-monospace,SFMono-Regular,monospace; font-size:12px; overflow:auto; }
    .tool summary { color:#eec086; cursor:pointer; font-family:Inter,system-ui,sans-serif; }
    .tool pre { white-space:pre-wrap; word-break:break-word; color:#c6cbd0; }
    img.result { display:block; max-width:100%; height:auto; border-radius:10px; margin:10px 0; border:1px solid var(--line); }
    .error { margin:8px 18px; color:#ffb0b0; background:#572b2b; padding:9px 12px; border-radius:9px; }
    .composerWrap { min-width:0; overflow:hidden; padding:12px max(14px,calc((100% - 900px)/2)) max(12px,env(safe-area-inset-bottom)); background:linear-gradient(transparent,#111315 25%); }
    .controls { display:flex; min-width:0; max-width:100%; gap:8px; margin-bottom:7px; overflow:auto; }
    select,.cwd { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:7px 9px; font-size:12px; min-width:0; }
    .cwd { flex:1; }
    .composer { min-width:0; width:100%; border:1px solid var(--line); background:var(--panel); border-radius:16px; padding:10px; box-shadow:0 14px 50px #0005; }
    textarea { border:0; outline:0; background:transparent; resize:none; width:100%; min-height:54px; max-height:180px; padding:5px; }
    .actions { display:flex; min-width:0; align-items:center; gap:8px; }
    .attach,.abort { padding:8px 10px; border-radius:9px; background:var(--raised); }
    .send { flex:0 0 auto; margin-left:auto; padding:9px 14px; border-radius:10px; background:var(--accent); color:#17120b; font-weight:750; }
    .send:disabled { opacity:.45; cursor:default; }
    .uploads { color:var(--muted); font-size:12px; flex:1; }
    @media(max-width:760px) {
      .shell { grid-template-columns:1fr; }
      aside { position:fixed; inset:0 18% 0 0; z-index:10; box-shadow:20px 0 80px #000a; transform:translateX(-105%); transition:transform .2s; }
      aside.open { transform:translateX(0); }
      .hamburger { display:block; }
      .timeline { padding:18px 14px; }
      .message { max-width:94%; }
      header { padding-left:12px; }
    }
  `;

  declare connected: boolean;
  declare daemonConnected: boolean;
  declare sessions: SessionSummary[];
  declare current: SessionSnapshot | undefined;
  declare timeline: unknown[];
  declare status: "idle" | "running" | "aborting" | "error";
  declare error: string;
  declare sidebarOpen: boolean;
  declare draft: string;
  declare cwd: string;
  declare delivery: "steer" | "followUp";
  declare attachmentIds: string[];
  private socket?: WebSocket;
  private reconnect?: number;

  constructor() {
    super();
    this.connected = false;
    this.daemonConnected = false;
    this.sessions = [];
    this.current = undefined;
    this.timeline = [];
    this.status = "idle";
    this.error = "";
    this.sidebarOpen = false;
    this.draft = "";
    this.cwd = "";
    this.delivery = "followUp";
    this.attachmentIds = [];
  }

  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    try {
      const response = await fetch("/api/bootstrap");
      if (!response.ok) throw new Error(`Bootstrap failed (${response.status})`);
      const bootstrap = await response.json() as Bootstrap;
      this.cwd = bootstrap.defaultCwd;
      this.connect();
      if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js");
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.reconnect) window.clearTimeout(this.reconnect);
    this.socket?.close();
  }

  private connect(): void {
    const url = new URL("/api/ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      this.connected = true;
      this.daemonConnected = true;
      this.send({ type: "session.list" });
      if (this.current) this.send({ type: "session.open", sessionId: this.current.id });
    };
    socket.onclose = () => {
      this.connected = false;
      this.daemonConnected = false;
      this.reconnect = window.setTimeout(() => this.connect(), 1_000);
    };
    socket.onerror = () => { this.error = "Connection failed"; };
    socket.onmessage = (message) => this.receive(JSON.parse(String(message.data)) as ServerEvent);
  }

  private receive(message: ServerEvent): void {
    switch (message.type) {
      case "ready": {
        this.daemonConnected = true;
        const resumeId = message.activeSessionId || window.localStorage.getItem("pi-daemon-last-session");
        if (resumeId) this.send({ type: "session.open", sessionId: resumeId });
        break;
      }
      case "session.list": this.sessions = message.sessions; break;
      case "session.snapshot":
        this.current = message.session;
        window.localStorage.setItem("pi-daemon-last-session", message.session.id);
        this.timeline = [...message.session.messages];
        this.status = message.session.streaming ? "running" : "idle";
        this.cwd = message.session.cwd;
        this.sidebarOpen = false;
        this.send({ type: "session.list" });
        break;
      case "session.event":
        if (message.sessionId === this.current?.id) this.applyAgentEvent(message.event);
        break;
      case "session.status":
        if (message.sessionId === this.current?.id) this.status = message.status;
        if (message.message) this.error = message.message;
        if (message.status === "idle") this.send({ type: "session.open", sessionId: message.sessionId });
        break;
      case "error":
        if (message.code === "daemon_unavailable") this.daemonConnected = false;
        this.error = message.message;
        break;
    }
    this.updateComplete.then(() => this.scrollToBottom());
  }

  private send(command: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const envelope = { protocolVersion: 1, requestId: crypto.randomUUID(), ...command } as ClientCommand;
    this.socket.send(JSON.stringify(envelope));
  }

  private createSession(): void {
    this.send({ type: "session.create", cwd: this.cwd || "." });
  }

  private submit(): void {
    const text = this.draft.trim();
    if (!text || !this.current) return;
    const type = this.status === "running" ? `session.${this.delivery}` : "session.prompt";
    this.send({ type, sessionId: this.current.id, text, attachments: this.attachmentIds.map((id) => ({ id, mimeType: "image/png" })) });
    this.draft = "";
    this.attachmentIds = [];
  }

  private async upload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const form = new FormData();
    for (const file of input.files) form.append("image", file);
    const response = await fetch("/api/attachments", { method: "POST", body: form });
    const result = await response.json() as { attachments?: Array<{ id: string }>; error?: string };
    if (!response.ok) { this.error = result.error || "Upload failed"; return; }
    this.attachmentIds = [...this.attachmentIds, ...(result.attachments || []).map((item) => item.id)];
    input.value = "";
  }

  private renderItem(item: unknown): TemplateResult {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : undefined;
    const nestedMessage = record?.message && typeof record.message === "object" ? record.message as Record<string, unknown> : record;
    const role = String(nestedMessage?.role || "event");
    if (role === "user" || role === "assistant") {
      return html`<article class="message ${role}">${role === "assistant" ? html`<div class="label">Pi</div>` : nothing}${this.renderContent(nestedMessage?.content)}</article>`;
    }
    const eventType = String(record?.type || "event");
    if (eventType.startsWith("tool_execution_")) {
      const toolName = String(record?.toolName || "tool");
      const result = record?.result && typeof record.result === "object" ? record.result as Record<string, unknown> : undefined;
      return html`<details class="tool" ?open=${eventType === "tool_execution_end"}><summary>${toolName} · ${eventType.replace("tool_execution_", "")}</summary>${result?.content ? this.renderContent(result.content) : nothing}<pre>${JSON.stringify(record?.args || record?.partialResult || (result ? { ...result, content: undefined } : {}), null, 2)}</pre></details>`;
    }
    if (["message_start", "message_update", "message_end", "turn_start", "turn_end", "agent_start", "agent_end", "agent_settled", "entry_appended"].includes(eventType)) return html``;
    return html`<details class="tool"><summary>${eventType.replaceAll("_", " ")}</summary><pre>${JSON.stringify(item, null, 2)}</pre></details>`;
  }

  private renderContent(content: unknown): TemplateResult {
    if (typeof content === "string") return html`${content}`;
    if (!Array.isArray(content)) return html`${content == null ? "" : JSON.stringify(content)}`;
    return html`${content.map((part) => {
      if (!part || typeof part !== "object") return html`${String(part)}`;
      const value = part as Record<string, unknown>;
      if (value.type === "text" || value.type === "thinking") return html`${String(value.text || value.thinking || "")}`;
      if (value.type === "image" && typeof value.data === "string") return html`<img class="result" alt="Computer screenshot" src="data:${String(value.mimeType || "image/png")};base64,${value.data}" />`;
      return html`<details class="tool"><summary>${String(value.type || "content")}</summary><pre>${JSON.stringify(value, null, 2)}</pre></details>`;
    })}`;
  }

  private scrollToBottom(): void {
    const container = this.renderRoot.querySelector(".timeline");
    if (container) container.scrollTop = container.scrollHeight;
  }

  private applyAgentEvent(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const agentEvent = value as Record<string, unknown>;
    const type = String(agentEvent.type || "event");
    if (["message_start", "message_update", "message_end"].includes(type) && agentEvent.message) {
      const withoutLive = this.timeline.filter((item) => !(item && typeof item === "object" && (item as Record<string, unknown>).__live));
      this.timeline = type === "message_end" ? [...withoutLive, agentEvent.message] : [...withoutLive, { __live: true, message: agentEvent.message }];
      return;
    }
    if (["turn_start", "turn_end", "agent_start", "agent_end", "agent_settled", "entry_appended"].includes(type)) return;
    this.timeline = [...this.timeline, value];
  }

  render(): TemplateResult {
    const title = this.current?.name || this.current?.messages?.length && "Pi session" || "New session";
    return html`
      <div class="shell">
        <aside class=${this.sidebarOpen ? "open" : ""}>
          <div class="brand"><span class="mark">π</span><h1>Pi Daemon</h1><span class="connection ${this.connected && this.daemonConnected ? "on" : ""}"></span></div>
          <button class="new" @click=${this.createSession}>＋ New session</button>
          <div class="sessions">${this.sessions.map((session) => html`
            <button class="session ${session.id === this.current?.id ? "active" : ""}" @click=${() => this.send({ type: "session.open", sessionId: session.id })}>
              <strong>${session.name || session.firstMessage || "Untitled session"}</strong><small>${session.cwd}</small>
            </button>`)}
          </div>
        </aside>
        <main>
          <header>
            <button class="hamburger" @click=${() => { this.sidebarOpen = !this.sidebarOpen; }}>☰</button>
            <div class="title" @dblclick=${() => this.renameCurrent()}><strong>${title}</strong><small>${this.current?.cwd || this.cwd}</small></div>
            ${this.current ? html`<button class="hamburger" title="Rename session" @click=${() => this.renameCurrent()}>✎</button>` : nothing}
            <span class="status ${this.status}">${this.status}</span>
          </header>
          <section class="timeline">
            ${this.timeline.length ? this.timeline.map((item) => this.renderItem(item)) : html`<div class="empty"><div><strong>Pi is ready.</strong><br />Create a session and send a task from your phone.</div></div>`}
          </section>
          ${this.error ? html`<div class="error" @click=${() => { this.error = ""; }}>${this.error}</div>` : nothing}
          <section class="composerWrap">
            <div class="controls">
              <input class="cwd" aria-label="Working directory" .value=${this.cwd} @input=${(event: InputEvent) => { this.cwd = (event.target as HTMLInputElement).value; }} />
              ${this.current?.availableModels.length ? html`<select aria-label="Model" .value=${this.current.model ? `${this.current.model.provider}/${this.current.model.id}` : ""} @change=${(event: Event) => {
                if (!this.current) return;
                const selected = this.current.availableModels[(event.target as HTMLSelectElement).selectedIndex];
                if (selected) this.send({ type: "session.setModel", sessionId: this.current.id, provider: selected.provider, modelId: selected.id });
              }}>${this.current.availableModels.map((model) => html`<option value=${`${model.provider}/${model.id}`}>${model.name || `${model.provider}/${model.id}`}</option>`)}</select>` : nothing}
              ${this.status === "running" ? html`<select .value=${this.delivery} @change=${(event: Event) => { this.delivery = (event.target as HTMLSelectElement).value as "steer" | "followUp"; }}><option value="followUp">Follow up</option><option value="steer">Steer</option></select>` : nothing}
              <select aria-label="Thinking level" .value=${this.current?.thinking || "medium"} @change=${(event: Event) => this.current && this.send({ type: "session.setThinking", sessionId: this.current.id, thinking: (event.target as HTMLSelectElement).value as ThinkingLevel })}>
                ${["off","minimal","low","medium","high","xhigh","max"].map((level) => html`<option value=${level} ?selected=${level === (this.current?.thinking || "medium")}>${level}</option>`)}
              </select>
            </div>
            <div class="composer">
              <textarea placeholder=${this.current ? "Ask Pi to work on something…" : "Create a session first"} .value=${this.draft} @input=${(event: InputEvent) => { this.draft = (event.target as HTMLTextAreaElement).value; }} @keydown=${(event: KeyboardEvent) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); this.submit(); } }}></textarea>
              <div class="actions">
                <label class="attach">＋<input hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple @change=${this.upload} /></label>
                <span class="uploads">${this.attachmentIds.length ? `${this.attachmentIds.length} image(s)` : ""}</span>
                ${this.status === "running" ? html`<button class="abort" @click=${() => this.current && this.send({ type: "session.abort", sessionId: this.current.id })}>Stop</button>` : nothing}
                <button class="send" ?disabled=${!this.current || !this.draft.trim()} @click=${this.submit}>Send</button>
              </div>
            </div>
          </section>
        </main>
      </div>`;
  }

  private renameCurrent(): void {
    if (!this.current) return;
    const name = window.prompt("Session name", this.current.name || "");
    if (name?.trim()) this.send({ type: "session.rename", sessionId: this.current.id, name: name.trim() });
  }
}

customElements.define("pi-daemon-app", PiDaemonApp);

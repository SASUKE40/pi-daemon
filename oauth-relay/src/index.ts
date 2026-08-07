const SESSION_TTL_MS = 5 * 60_000;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

interface DurableObjectId {}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(time: number): Promise<void>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
}

interface Env {
  OAUTH_SESSIONS: DurableObjectNamespace;
}

interface InitBody {
  pollSecretHash?: string;
}

interface CompleteBody {
  code?: string;
  error?: string;
  errorDescription?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/sessions") return createSession(request, env);
    if (request.method === "GET" && url.pathname === "/callback") return completeSession(url, env);
    const match = url.pathname.match(/^\/sessions\/([A-Za-z0-9_-]{43})$/);
    if (match?.[1] && (request.method === "GET" || request.method === "DELETE")) {
      const stub = env.OAUTH_SESSIONS.get(env.OAUTH_SESSIONS.idFromName(match[1]));
      return stub.fetch(new Request(`https://session.internal/${request.method === "GET" ? "poll" : "consume"}`, {
        method: request.method,
        headers: request.headers,
      }));
    }
    if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true });
    return text("Not found", 404);
  },
};

export class OAuthSession {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/init") return this.initialize(request);
    if (request.method === "POST" && url.pathname === "/complete") return this.complete(request);
    if (request.method === "GET" && url.pathname === "/poll") return this.poll(request);
    if (request.method === "DELETE" && url.pathname === "/consume") return this.consume(request);
    return text("Not found", 404);
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }

  private async initialize(request: Request): Promise<Response> {
    const body = await readJson<InitBody>(request);
    if (!body || !body.pollSecretHash || !HASH_PATTERN.test(body.pollSecretHash)) return text("Invalid session", 400);
    if (await this.state.storage.get("pollSecretHash")) return text("Session already exists", 409);
    await this.state.storage.put({ pollSecretHash: body.pollSecretHash, createdAt: Date.now() });
    await this.state.storage.setAlarm(Date.now() + SESSION_TTL_MS);
    return new Response(null, { status: 201 });
  }

  private async complete(request: Request): Promise<Response> {
    if (!await this.state.storage.get("pollSecretHash")) return text("Session not found", 404);
    if (await this.state.storage.get("result")) return text("Session already completed", 409);
    const body = await readJson<CompleteBody>(request);
    if (!body || (!body.code && !body.error)) return text("Invalid authorization result", 400);
    await this.state.storage.put({ result: body });
    return new Response(null, { status: 204 });
  }

  private async poll(request: Request): Promise<Response> {
    if (!await this.authorized(request)) return text("Unauthorized", 401);
    const result = await this.state.storage.get<CompleteBody>("result");
    return result ? json(result) : new Response(null, { status: 204 });
  }

  private async consume(request: Request): Promise<Response> {
    if (!await this.authorized(request)) return text("Unauthorized", 401);
    await this.state.storage.deleteAll();
    return new Response(null, { status: 204 });
  }

  private async authorized(request: Request): Promise<boolean> {
    const expected = await this.state.storage.get<string>("pollSecretHash");
    const authorization = request.headers.get("Authorization");
    if (!expected || !authorization?.startsWith("Bearer ")) return false;
    const actual = await sha256(authorization.slice("Bearer ".length));
    return timingSafeEqual(expected, actual);
  }
}

async function createSession(request: Request, env: Env): Promise<Response> {
  const body = await readJson<{ state?: string; pollSecretHash?: string }>(request);
  if (!body?.state || !STATE_PATTERN.test(body.state) || !body.pollSecretHash || !HASH_PATTERN.test(body.pollSecretHash)) return text("Invalid session", 400);
  const stub = env.OAUTH_SESSIONS.get(env.OAUTH_SESSIONS.idFromName(body.state));
  return stub.fetch(new Request("https://session.internal/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pollSecretHash: body.pollSecretHash }),
  }));
}

async function completeSession(url: URL, env: Env): Promise<Response> {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");
  if (!state || !STATE_PATTERN.test(state) || (!code && !error)) return callbackPage(false, "The authorization response was incomplete.", 400);
  const stub = env.OAUTH_SESSIONS.get(env.OAUTH_SESSIONS.idFromName(state));
  const response = await stub.fetch(new Request("https://session.internal/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(code ? { code } : {}), ...(error ? { error } : {}), ...(errorDescription ? { errorDescription } : {}) }),
  }));
  if (!response.ok) return callbackPage(false, "This setup session expired. Return to the terminal and try again.", response.status);
  return error
    ? callbackPage(false, "Cloudflare authorization was declined. Return to the terminal to try again.", 400)
    : callbackPage(true, "Cloudflare is connected. You can close this page and return to the terminal.");
}

function callbackPage(success: boolean, message: string, status = 200): Response {
  const title = success ? "Cloudflare connected" : "Could not connect Cloudflare";
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><title>${title}</title><style>body{font:16px system-ui,sans-serif;max-width:38rem;margin:15vh auto;padding:0 1.5rem;color:#172033}main{border:1px solid #d9dfeb;border-radius:16px;padding:2rem;box-shadow:0 12px 40px #17203314}h1{font-size:1.5rem;margin-top:0}.ok{color:#087a55}.error{color:#b42318}</style><main><h1 class="${success ? "ok" : "error"}">${title}</h1><p>${message}</p></main></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}

async function readJson<T>(request: Request): Promise<T | undefined> {
  try {
    return await request.json() as T;
  } catch {
    return undefined;
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (item) => item.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

function text(value: string, status: number): Response {
  return new Response(value, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

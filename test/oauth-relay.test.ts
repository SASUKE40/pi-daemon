import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OAuthSession } from "../oauth-relay/src/index.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | undefined;

  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put(entries: Record<string, unknown>): Promise<void> { for (const [key, value] of Object.entries(entries)) this.values.set(key, value); }
  async deleteAll(): Promise<void> { this.values.clear(); }
  async setAlarm(time: number): Promise<void> { this.alarm = time; }
}

describe("OAuth callback relay session", () => {
  it("requires the private polling secret and consumes a completed callback", async () => {
    const storage = new MemoryStorage();
    const session = new OAuthSession({ storage });
    const pollSecret = "private-poll-secret";
    const pollSecretHash = createHash("sha256").update(pollSecret).digest("hex");

    const initialized = await session.fetch(new Request("https://session.internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pollSecretHash }),
    }));
    expect(initialized.status).toBe(201);
    expect(storage.alarm).toBeGreaterThan(Date.now());

    expect((await session.fetch(new Request("https://session.internal/poll"))).status).toBe(401);
    expect((await session.fetch(new Request("https://session.internal/poll", { headers: { Authorization: `Bearer ${pollSecret}` } }))).status).toBe(204);

    expect((await session.fetch(new Request("https://session.internal/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "one-time-authorization-code" }),
    }))).status).toBe(204);

    const completed = await session.fetch(new Request("https://session.internal/poll", { headers: { Authorization: `Bearer ${pollSecret}` } }));
    expect(await completed.json()).toEqual({ code: "one-time-authorization-code" });
    expect((await session.fetch(new Request("https://session.internal/consume", { method: "DELETE", headers: { Authorization: `Bearer ${pollSecret}` } }))).status).toBe(204);
    expect(storage.values.size).toBe(0);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAppPaths } from "../src/paths.js";
import { PushService, validatePushSubscription, type PushSender } from "../src/push.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

describe("PushService", () => {
  it("persists one private VAPID keypair across service instances", async () => {
    const { root, paths } = await testPaths();
    const first = await new PushService(paths).getPublicKey();
    const second = await new PushService(paths).getPublicKey();
    expect(second).toBe(first);
    expect((await stat(paths.pushVapidFile)).mode & 0o777).toBe(0o600);
    expect(root).toBeTruthy();
  });

  it("fans out a notification to every stored subscription", async () => {
    const { paths } = await testPaths();
    const deliveries: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
    const sender: PushSender = async (subscription, payload) => {
      deliveries.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
      return { statusCode: 201, body: "", headers: {} };
    };
    const service = new PushService(paths, sender);
    await service.subscribe(subscription("one"));
    await service.subscribe(subscription("two"));
    const result = await service.send({ sessionId: "session 1", outcome: "completed", body: "Finished the work" }, "https://localhost");
    expect(result).toEqual({ sent: 2, removed: 0, failed: 0 });
    expect(deliveries.map((item) => item.endpoint).sort()).toEqual([
      "https://push.example.test/one",
      "https://push.example.test/two",
    ].sort());
    expect(deliveries[0]?.payload).toMatchObject({ title: "Pi session complete", body: "Finished the work" });
    const files = await readdir(paths.pushSubscriptionsDir);
    expect(files).toHaveLength(2);
    expect((await stat(paths.pushSubscriptionsDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(paths.pushSubscriptionsDir, files[0] as string))).mode & 0o777).toBe(0o600);
  });

  it("upserts an endpoint without consuming a device slot and enforces the 16-device cap", async () => {
    const { paths } = await testPaths();
    const delivered: string[] = [];
    const service = new PushService(paths, async (item) => {
      delivered.push(item.keys.p256dh);
      return { statusCode: 201, body: "", headers: {} };
    });
    for (let index = 0; index < 16; index += 1) await service.subscribe(subscription(String(index)));
    await service.subscribe({ ...subscription("0"), keys: { p256dh: "updated", auth: "updated" } });
    await expect(service.subscribe(subscription("17"))).rejects.toThrow("At most 16");
    expect((await service.send({ sessionId: "s", outcome: "completed", body: "Done" }, "https://localhost")).sent).toBe(16);
    expect(delivered).toContain("updated");
  });

  it("removes expired endpoints but keeps transient failures", async () => {
    const { paths } = await testPaths();
    const attempts = new Map<string, number>();
    const sender: PushSender = async (item) => {
      attempts.set(item.endpoint, (attempts.get(item.endpoint) || 0) + 1);
      if (item.endpoint.endsWith("expired")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
      throw new Error("Temporary network failure");
    };
    const service = new PushService(paths, sender);
    await service.subscribe(subscription("expired"));
    await service.subscribe(subscription("retry"));
    expect(await service.send({ sessionId: "s", outcome: "failed", body: "Failed" }, "https://localhost")).toEqual({ sent: 0, removed: 1, failed: 1 });
    expect(await service.send({ sessionId: "s", outcome: "failed", body: "Failed" }, "https://localhost")).toEqual({ sent: 0, removed: 0, failed: 1 });
    expect(attempts.get("https://push.example.test/expired")).toBe(1);
    expect(attempts.get("https://push.example.test/retry")).toBe(2);
  });
});

describe("validatePushSubscription", () => {
  it("requires HTTPS endpoints and bounded base64url keys", () => {
    expect(() => validatePushSubscription({ ...subscription("bad"), endpoint: "http://push.example.test/bad" })).toThrow("HTTPS");
    expect(() => validatePushSubscription({ ...subscription("bad"), keys: { p256dh: "not valid", auth: "auth" } })).toThrow("p256dh");
    expect(validatePushSubscription(subscription("valid"))).toEqual(subscription("valid"));
  });
});

async function testPaths() {
  const root = await mkdtemp(join(tmpdir(), "pi-daemon-push-"));
  roots.push(root);
  return {
    root,
    paths: getAppPaths({ ...process.env, PI_DAEMON_HOME: root, XDG_RUNTIME_DIR: join(root, "runtime") }),
  };
}

function subscription(id: string) {
  return {
    endpoint: `https://push.example.test/${id}`,
    expirationTime: null,
    keys: { p256dh: `public_${id}`, auth: `auth_${id}` },
  };
}

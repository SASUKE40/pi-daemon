import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import webpush, { type PushSubscription, type RequestOptions, type SendResult, type VapidKeys } from "web-push";
import { log } from "./log.js";
import { getAppPaths, type AppPaths } from "./paths.js";

const MAX_SUBSCRIPTIONS = 16;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_KEY_LENGTH = 512;

export interface PushNotification {
  sessionId: string;
  outcome: "completed" | "failed";
  body: string;
}

export interface PushDeliveryResult {
  sent: number;
  removed: number;
  failed: number;
}

export type PushSender = (
  subscription: PushSubscription,
  payload: string,
  options: RequestOptions,
) => Promise<SendResult>;

export class PushService {
  private vapidPromise: Promise<VapidKeys> | undefined;

  constructor(
    private readonly paths: AppPaths = getAppPaths(),
    private readonly sender: PushSender = webpush.sendNotification,
  ) {}

  async getPublicKey(): Promise<string> {
    return (await this.ensureVapidKeys()).publicKey;
  }

  async subscribe(value: unknown): Promise<PushSubscription> {
    const subscription = validatePushSubscription(value);
    await this.ensureVapidKeys();
    await mkdir(this.paths.pushSubscriptionsDir, { recursive: true, mode: 0o700 });
    await chmod(this.paths.pushSubscriptionsDir, 0o700);
    const target = this.subscriptionPath(subscription.endpoint);
    const existing = await readFile(target, "utf8").then(() => true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (!existing) {
      const files = await readdir(this.paths.pushSubscriptionsDir);
      if (files.filter((file) => file.endsWith(".json")).length >= MAX_SUBSCRIPTIONS) {
        throw new PushSubscriptionLimitError(`At most ${MAX_SUBSCRIPTIONS} notification devices can be registered`);
      }
    }
    await writePrivateJson(target, subscription);
    if (!existing) {
      const files = (await readdir(this.paths.pushSubscriptionsDir)).filter((file) => file.endsWith(".json"));
      if (files.length > MAX_SUBSCRIPTIONS) {
        await unlink(target).catch(() => undefined);
        throw new PushSubscriptionLimitError(`At most ${MAX_SUBSCRIPTIONS} notification devices can be registered`);
      }
    }
    return subscription;
  }

  async unsubscribe(endpointValue: unknown): Promise<boolean> {
    const endpoint = normalizePushEndpoint(endpointValue, "A valid subscription endpoint is required");
    try {
      await unlink(this.subscriptionPath(endpoint));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async send(notification: PushNotification, subject: string): Promise<PushDeliveryResult> {
    const subscriptions = await this.listSubscriptions();
    if (!subscriptions.length) return { sent: 0, removed: 0, failed: 0 };
    const keys = await this.ensureVapidKeys();
    const payload = JSON.stringify({
      title: notification.outcome === "completed" ? "Pi session complete" : "Pi session failed",
      body: notification.body,
      icon: "/icon-192.png",
      badge: "/badge-96.png",
      tag: `pi-session-${notification.sessionId}`,
      data: {
        sessionId: notification.sessionId,
        url: `/?session=${encodeURIComponent(notification.sessionId)}`,
        outcome: notification.outcome,
      },
    });
    const result: PushDeliveryResult = { sent: 0, removed: 0, failed: 0 };
    await Promise.all(subscriptions.map(async (subscription) => {
      try {
        await this.sender(subscription, payload, {
          TTL: 60 * 60,
          urgency: notification.outcome === "failed" ? "high" : "normal",
          topic: endpointHash(notification.sessionId).slice(0, 32),
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        });
        result.sent += 1;
      } catch (error) {
        const statusCode = typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : undefined;
        if (statusCode === 404 || statusCode === 410) {
          await this.unsubscribe(subscription.endpoint).catch(() => undefined);
          result.removed += 1;
          return;
        }
        result.failed += 1;
        log.warn("web push delivery failed", {
          endpoint: safeEndpoint(subscription.endpoint),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }));
    return result;
  }

  private async listSubscriptions(): Promise<PushSubscription[]> {
    let files: string[];
    try {
      files = await readdir(this.paths.pushSubscriptionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const subscriptions: PushSubscription[] = [];
    for (const file of files.filter((item) => item.endsWith(".json"))) {
      const path = join(this.paths.pushSubscriptionsDir, file);
      try {
        subscriptions.push(validatePushSubscription(JSON.parse(await readFile(path, "utf8"))));
      } catch (error) {
        log.warn("removing invalid web push subscription", {
          file,
          message: error instanceof Error ? error.message : String(error),
        });
        await unlink(path).catch(() => undefined);
      }
    }
    return subscriptions;
  }

  private ensureVapidKeys(): Promise<VapidKeys> {
    this.vapidPromise ??= this.loadOrCreateVapidKeys();
    return this.vapidPromise;
  }

  private async loadOrCreateVapidKeys(): Promise<VapidKeys> {
    try {
      return validateVapidKeys(JSON.parse(await readFile(this.paths.pushVapidFile, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const keys = webpush.generateVAPIDKeys();
    await writePrivateJson(this.paths.pushVapidFile, keys);
    return keys;
  }

  private subscriptionPath(endpoint: string): string {
    return join(this.paths.pushSubscriptionsDir, `${endpointHash(endpoint)}.json`);
  }
}

export class PushSubscriptionLimitError extends Error {}

export function validatePushSubscription(value: unknown): PushSubscription {
  if (!value || typeof value !== "object") throw new Error("Invalid push subscription");
  const item = value as Record<string, unknown>;
  const endpoint = normalizePushEndpoint(item.endpoint, "Invalid push subscription endpoint");
  if (!item.keys || typeof item.keys !== "object") throw new Error("Push subscription keys are required");
  const keys = item.keys as Record<string, unknown>;
  const p256dh = validateSubscriptionKey(keys.p256dh, "p256dh");
  const auth = validateSubscriptionKey(keys.auth, "auth");
  const expirationTime = item.expirationTime;
  if (expirationTime !== undefined && expirationTime !== null && (!Number.isFinite(expirationTime) || Number(expirationTime) <= 0)) {
    throw new Error("Invalid push subscription expirationTime");
  }
  return {
    endpoint,
    ...(expirationTime === null || typeof expirationTime === "number" ? { expirationTime } : {}),
    keys: { p256dh, auth },
  };
}

function normalizePushEndpoint(value: unknown, invalidMessage: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_ENDPOINT_LENGTH) throw new Error(invalidMessage);
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(invalidMessage);
  }
  if (endpoint.protocol !== "https:") throw new Error("Push subscription endpoint must use HTTPS");
  return endpoint.toString();
}

function validateSubscriptionKey(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_KEY_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid push subscription ${name} key`);
  }
  return value;
}

function validateVapidKeys(value: unknown): VapidKeys {
  if (!value || typeof value !== "object") throw new Error("Invalid VAPID key file");
  const item = value as Record<string, unknown>;
  if (typeof item.publicKey !== "string" || typeof item.privateKey !== "string") throw new Error("Invalid VAPID key file");
  return { publicKey: item.publicKey, privateKey: item.privateKey };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function endpointHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEndpoint(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
}

export type SyncMessage =
  | { type: "token"; sessionId: string; template: string | null; token: string }
  | { type: "signout" }
  | { type: "refresh-client" };

const CHANNEL_NAME = "orbitid";
const STORAGE_KEY = "__orbitid_sync";

/**
 * Cross-tab synchronisation: `BroadcastChannel` where available, `localStorage` + `storage` events otherwise.
 * Never touched during SSR (constructed lazily by `OrbitID.load`).
 *
 * Session JWTs only ever travel over `BroadcastChannel`, which lives in memory and dies with the tab.
 * The `localStorage` fallback carries state signals only: writing a bearer token into persistent storage
 * would outlive the tab, survive a crash and stay readable to any later same-origin script. Tabs do not
 * need it anyway — `__session` is a shared cookie, so a token one tab mints is already visible to the rest.
 */
export class CrossTabSync {
  private channel: BroadcastChannel | null = null;
  private storageHandler: ((event: StorageEvent) => void) | null = null;
  private closed = false;

  constructor(private readonly onMessage: (message: SyncMessage) => void) {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (event: MessageEvent) => this.receive(event.data, "channel");
      return;
    }
    if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
      this.storageHandler = (event: StorageEvent) => {
        if (event.key !== STORAGE_KEY || !event.newValue) return;
        try {
          this.receive(JSON.parse(event.newValue), "storage");
        } catch {
          /* ignore malformed cross-tab payloads */
        }
      };
      window.addEventListener("storage", this.storageHandler);
    }
  }

  /** Structural check of an untrusted payload (another tab, or any script that can write the storage key). */
  private receive(data: unknown, source: "channel" | "storage"): void {
    if (this.closed || !data || typeof data !== "object") return;
    const message = data as Record<string, unknown>;
    switch (message.type) {
      case "token":
        // Never written to persistent storage, so a token arriving through it was not sent by this SDK.
        if (source === "storage") return;
        if (typeof message.sessionId !== "string" || !message.sessionId) return;
        if (typeof message.token !== "string" || !message.token) return;
        // Only the default session token is shared between tabs. A template token is a least-privilege
        // credential for another service: a tab that needs one mints its own, so a token carrying
        // `template` is dropped instead of being cached and handed out here.
        if (message.template !== null && message.template !== undefined) return;
        this.onMessage({ type: "token", sessionId: message.sessionId, template: null, token: message.token });
        return;
      case "signout":
      case "refresh-client":
        this.onMessage({ type: message.type });
        return;
      default:
        return;
    }
  }

  broadcast(message: SyncMessage): void {
    if (this.closed) return;
    if (this.channel) {
      this.channel.postMessage(message);
      return;
    }
    // Persistent storage never carries a credential. The cookie already did the job for other tabs.
    if (message.type === "token") return;
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(message));
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage may be unavailable (private mode) */
    }
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
    this.channel = null;
    if (this.storageHandler && typeof window !== "undefined") window.removeEventListener("storage", this.storageHandler);
    this.storageHandler = null;
  }
}

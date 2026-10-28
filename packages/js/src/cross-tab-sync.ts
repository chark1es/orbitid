export type SyncMessage =
  | { type: "token"; sessionId: string; template: string | null; token: string }
  | { type: "signout" }
  | { type: "refresh-client" };

const CHANNEL_NAME = "orbitid";
const STORAGE_KEY = "__orbitid_sync";

/**
 * Cross-tab synchronisation: `BroadcastChannel` where available, `localStorage` + `storage` events otherwise.
 * Never touched during SSR (constructed lazily by `OrbitID.load`).
 */
export class CrossTabSync {
  private channel: BroadcastChannel | null = null;
  private storageHandler: ((event: StorageEvent) => void) | null = null;
  private closed = false;

  constructor(private readonly onMessage: (message: SyncMessage) => void) {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (event: MessageEvent) => this.receive(event.data);
      return;
    }
    if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
      this.storageHandler = (event: StorageEvent) => {
        if (event.key !== STORAGE_KEY || !event.newValue) return;
        try {
          this.receive(JSON.parse(event.newValue));
        } catch {
          /* ignore malformed cross-tab payloads */
        }
      };
      window.addEventListener("storage", this.storageHandler);
    }
  }

  private receive(data: unknown): void {
    if (this.closed || !data || typeof data !== "object") return;
    const message = data as SyncMessage;
    if (typeof message.type !== "string") return;
    this.onMessage(message);
  }

  broadcast(message: SyncMessage): void {
    if (this.closed) return;
    if (this.channel) {
      this.channel.postMessage(message);
      return;
    }
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

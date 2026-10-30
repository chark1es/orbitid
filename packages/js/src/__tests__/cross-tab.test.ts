import { afterEach, describe, expect, it, vi } from "vitest";
import { CrossTabSync, type SyncMessage } from "../cross-tab-sync";

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;
  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  close(): void {
    this.closed = true;
  }
  emit(message: SyncMessage): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

describe("CrossTabSync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeBroadcastChannel.instances = [];
  });

  it("broadcasts and receives messages over BroadcastChannel", () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const received: SyncMessage[] = [];
    const sync = new CrossTabSync((message) => received.push(message));
    sync.broadcast({ type: "signout" });

    const channel = FakeBroadcastChannel.instances[0]!;
    expect(channel.name).toBe("orbitid");
    expect(channel.sent).toEqual([{ type: "signout" }]);

    channel.emit({ type: "token", sessionId: "sess_1", template: null, token: "jwt" });
    expect(received).toEqual([{ type: "token", sessionId: "sess_1", template: null, token: "jwt" }]);

    sync.close();
    expect(channel.closed).toBe(true);
    channel.emit({ type: "signout" });
    expect(received).toHaveLength(1);
  });

  it("falls back to localStorage when BroadcastChannel is unavailable", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const sync = new CrossTabSync(() => undefined);
    sync.broadcast({ type: "refresh-client" });
    expect(setItem).toHaveBeenCalledWith("__orbitid_sync", JSON.stringify({ type: "refresh-client" }));
    sync.close();
    setItem.mockRestore();
  });

  it("never writes a session token to localStorage", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const sync = new CrossTabSync(() => undefined);
    sync.broadcast({ type: "token", sessionId: "sess_1", template: null, token: "secret-jwt" });
    expect(setItem).not.toHaveBeenCalled();
    sync.close();
    setItem.mockRestore();
  });
});

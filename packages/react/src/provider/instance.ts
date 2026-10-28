import * as OrbitIDJS from "@orbitid/js";
import type { OrbitIDInstance, OrbitIDOptions } from "./types";

type OrbitIDConstructor = new (publishableKey: string, options?: OrbitIDOptions) => unknown;

/**
 * `@orbitid/js` and `@orbitid/react` are versioned together but built independently, so the
 * concrete class is resolved at runtime and narrowed to the structural `OrbitIDInstance`
 * contract this package depends on (same relationship clerk-js has with @clerk/clerk-react).
 */
function resolveOrbitIDConstructor(): OrbitIDConstructor {
  const candidate: unknown = (OrbitIDJS as Record<string, unknown>).OrbitID;
  if (typeof candidate !== "function") {
    throw new Error(
      "[OrbitID] `@orbitid/js` does not export an `OrbitID` class. Pass a pre-built instance via `orbit` or install a compatible @orbitid/js.",
    );
  }
  return candidate as OrbitIDConstructor;
}

const instances = new Map<string, OrbitIDInstance>();
const loadPromises = new WeakMap<OrbitIDInstance, Promise<void>>();

/** One instance per publishable key, so React StrictMode double renders (and remounts) share it. */
export function getOrbitIDInstance(publishableKey: string, options: OrbitIDOptions = {}): OrbitIDInstance {
  const existing = instances.get(publishableKey);
  if (existing) return existing;
  const OrbitID = resolveOrbitIDConstructor();
  const instance = new OrbitID(publishableKey, options) as unknown as OrbitIDInstance;
  instances.set(publishableKey, instance);
  return instance;
}

/** `load()` at most once per instance; a failed load can be retried. */
export function loadOrbitID(instance: OrbitIDInstance): Promise<void> {
  if (instance.loaded) return Promise.resolve();
  const pending = loadPromises.get(instance);
  if (pending) return pending;
  const promise = Promise.resolve(instance.load()).catch((error: unknown) => {
    loadPromises.delete(instance);
    throw error;
  });
  loadPromises.set(instance, promise);
  return promise;
}

/** Test helper: drop cached instances so each test starts from a clean module state. */
export function resetOrbitIDInstances(): void {
  instances.clear();
}

/**
 * Server-side stand-in: hooks read `initialState`, so nothing touches `window` during SSR.
 * Browser-only members throw a descriptive error instead of silently no-oping.
 */
export function createServerOrbitID(publishableKey: string, options: OrbitIDOptions = {}): OrbitIDInstance {
  const unavailable = () => {
    throw new Error(
      "[OrbitID] The OrbitID instance is not available on the server. Use `initialState` for the initial render and call instance methods after hydration.",
    );
  };
  return {
    loaded: false,
    publishableKey,
    options,
    client: null,
    session: null,
    user: null,
    organization: null,
    environment: null,
    signIn: undefined,
    signUp: undefined,
    addListener: () => () => {},
    load: () => Promise.resolve(),
    setActive: unavailable,
    signOut: unavailable,
    createOrganization: unavailable,
    getOrganization: unavailable,
    apiKeys: undefined,
  };
}

export interface InstanceStore {
  subscribe(listener: () => void): () => void;
  /** Monotonic version; changes on every instance event. */
  getSnapshot(): number;
}

const stores = new WeakMap<OrbitIDInstance, InstanceStore>();
const EMPTY_STORE: InstanceStore = { subscribe: () => () => {}, getSnapshot: () => 0 };

/**
 * `useSyncExternalStore` adapter. The listener is attached lazily on the first subscriber and
 * detached when the last one goes away, so unmounted trees do not keep the SDK awake.
 */
export function getInstanceStore(instance: OrbitIDInstance | null): InstanceStore {
  if (!instance) return EMPTY_STORE;
  const existing = stores.get(instance);
  if (existing) return existing;

  let version = 0;
  let unsubscribe: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const store: InstanceStore = {
    subscribe(listener) {
      if (listeners.size === 0) {
        unsubscribe = instance.addListener(() => {
          version += 1;
          listeners.forEach((notify) => notify());
        });
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
      };
    },
    getSnapshot: () => version,
  };
  stores.set(instance, store);
  return store;
}

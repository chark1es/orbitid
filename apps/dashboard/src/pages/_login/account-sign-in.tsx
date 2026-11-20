import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, type NavigateFunction } from "react-router-dom";
import { OrbitID } from "@orbitid/js";
import { OrbitIDProvider, SignIn, useAuth as useAccountAuth, type OrbitIDInstance } from "@orbitid/react";

/**
 * The instance's own sign-in, the one its users see in your apps: every enabled method, second factors and passkeys
 * included. Loaded only on the sign-in screen, and only when nobody is signed in yet.
 *
 * The SDK talks to this page's origin. On the instance that is the Frontend API itself; behind the Vite dev server the
 * `/v1` proxy forwards it, so the `__client` cookie is first-party either way.
 */

interface Prepared {
  publishableKey: string;
  orbit: OrbitIDInstance;
  /** The SDK navigates through the router of whichever form is mounted; until then, through the browser. */
  navigate: { current: NavigateFunction | null };
}

let prepared: Prepared | null = null;

function createInstance(publishableKey: string): Prepared {
  const navigate: Prepared["navigate"] = { current: null };
  const orbit = new OrbitID(publishableKey, {
    frontendApi: window.location.origin,
    routerPush: (to: string) => (navigate.current ? navigate.current(to) : window.location.assign(to)),
    routerReplace: (to: string) => (navigate.current ? navigate.current(to, { replace: true }) : window.location.replace(to)),
  }) as unknown as OrbitIDInstance;
  // The provider loads it too and reports failures; this only starts the requests before React gets there.
  void Promise.resolve(orbit.load()).catch(() => {});
  return { publishableKey, orbit, navigate };
}

/**
 * Creates the SDK client and starts loading `/v1/client` as soon as this chunk arrives, so the requests overlap the
 * render instead of waiting for the provider to mount. The next form that mounts takes it; a later mount (after
 * signing out, say) starts fresh, so it never shows a stale client.
 */
export function prepareAccountSignIn(publishableKey: string): void {
  if (prepared?.publishableKey !== publishableKey) prepared = createInstance(publishableKey);
}

export default function AccountSignIn({ publishableKey, onSignedIn }: { publishableKey: string; onSignedIn: () => void }) {
  const navigate = useNavigate();
  const [{ orbit, navigate: router }] = useState(() =>
    prepared?.publishableKey === publishableKey ? prepared : createInstance(publishableKey),
  );
  useLayoutEffect(() => {
    router.current = navigate;
  }, [router, navigate]);
  // Taken: the next mount gets its own client.
  useEffect(() => {
    if (prepared?.orbit === orbit) prepared = null;
  }, [orbit]);

  return (
    <OrbitIDProvider publishableKey={publishableKey} orbit={orbit}>
      <SignedInWatcher onSignedIn={onSignedIn} />
      {/* Full width inside the dashboard column; the card keeps its own step titles (second factor, reset, …). */}
      <SignIn routing="virtual" withSignUp={false} appearance={{ elements: { rootBox: "items-stretch", card: "max-w-none shadow-none" } }} />
    </OrbitIDProvider>
  );
}

/** Hands control back to the dashboard as soon as the account has an active session. */
function SignedInWatcher({ onSignedIn }: { onSignedIn: () => void }) {
  const { isLoaded, isSignedIn } = useAccountAuth();
  const reported = useRef(false);
  useEffect(() => {
    if (isLoaded && isSignedIn && !reported.current) {
      reported.current = true;
      onSignedIn();
    }
  }, [isLoaded, isSignedIn, onSignedIn]);
  return null;
}

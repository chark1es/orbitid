import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@orbitid/ui";
import { Loader2, LockKeyhole, ShieldCheck } from "lucide-react";
import { api, getApiUrl, setApiUrl, setSecretKey } from "../lib/api";
import { useAuth } from "../lib/auth";
import { errorMessage } from "../lib/errors";
import { ThemeToggle } from "../components/layout/theme-toggle";

function redirectTarget(state: unknown): string {
  if (state && typeof state === "object" && "from" in state && typeof state.from === "string" && state.from.startsWith("/")) {
    return state.from;
  }
  return "/";
}

export default function LoginPage() {
  const { authenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [apiUrl, setApiUrlInput] = useState(getApiUrl());
  const [secretKey, setSecretKeyInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (authenticated) return <Navigate to={redirectTarget(location.state)} replace />;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!apiUrl.trim()) {
      setError("Enter the URL of your OrbitID instance.");
      return;
    }
    if (!secretKey.trim()) {
      setError("Enter your instance secret key.");
      return;
    }
    setPending(true);
    // Validate before committing the key so a typo does not poison every later request.
    setApiUrl(apiUrl);
    setSecretKey(secretKey);
    try {
      await api("GET", "/instance");
      signIn(apiUrl, secretKey);
      navigate(redirectTarget(location.state), { replace: true });
    } catch (cause) {
      setSecretKey(null);
      setError(errorMessage(cause, "Could not reach the instance."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="relative flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/30 px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <svg viewBox="0 0 32 32" className="size-5" aria-hidden>
            <circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" strokeWidth="3" />
            <circle cx="16" cy="16" r="2.5" fill="currentColor" />
          </svg>
        </span>
        OrbitID
      </div>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">Sign in to your instance</CardTitle>
          <CardDescription>
            Use the secret key from your OrbitID environment. It is kept in this tab's session storage and never leaves your
            browser.
          </CardDescription>
        </CardHeader>
        <form onSubmit={onSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="api-url">Instance URL</Label>
              <Input
                id="api-url"
                name="apiUrl"
                value={apiUrl}
                onChange={(event) => setApiUrlInput(event.target.value)}
                placeholder="http://localhost:4000"
                autoComplete="url"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">The origin serving the OrbitID API (no trailing slash).</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="secret-key">Secret key</Label>
              <Input
                id="secret-key"
                name="secretKey"
                type="password"
                value={secretKey}
                onChange={(event) => setSecretKeyInput(event.target.value)}
                placeholder="sk_test_…"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!error}
              />
              <p className="text-xs text-muted-foreground">Server-side key with full Backend API access.</p>
            </div>
            {error ? (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-3">
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : <LockKeyhole aria-hidden />}
              {pending ? "Verifying…" : "Sign in"}
            </Button>
            <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5" aria-hidden />
              Stored per tab — close the tab to forget the key.
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}

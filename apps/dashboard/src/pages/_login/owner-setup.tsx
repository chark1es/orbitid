import { useState, type FormEvent } from "react";
import { Button, Input, Label } from "@orbitid/ui";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useAuth } from "../../lib/auth";
import { errorMessage } from "../../lib/errors";
import { FormError } from "./form-error";

/** First run: the person who finishes this form owns the instance. */
export function OwnerSetup({ onDone }: { onDone: () => void }) {
  const { setupOwner } = useAuth();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError("Enter the email address you will sign in with.");
      return;
    }
    if (!password) {
      setError("Choose a password for the owner account.");
      return;
    }
    setPending(true);
    try {
      await setupOwner({
        first_name: firstName.trim() || undefined,
        last_name: lastName.trim() || undefined,
        email_address: email.trim(),
        password,
      });
      setPassword("");
      onDone();
    } catch (cause) {
      setError(errorMessage(cause, "The instance did not answer. Check that the server is running, then try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <h1 id="sign-in-heading" className="text-[1.75rem] leading-tight">
        Create the owner account
      </h1>
      <p className="mt-2 max-w-[60ch] text-sm text-muted-foreground">
        This instance has no accounts yet. The account you create here becomes its owner and opens the admin console;
        no secret key needed.
      </p>

      <form onSubmit={onSubmit} className="mt-8 space-y-5" noValidate>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="owner-first-name">First name</Label>
            <Input
              id="owner-first-name"
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
              autoComplete="given-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="owner-last-name">Last name</Label>
            <Input
              id="owner-last-name"
              value={lastName}
              onChange={(event) => setLastName(event.target.value)}
              autoComplete="family-name"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="owner-email">Email address</Label>
          <Input
            id="owner-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            spellCheck={false}
            required
            aria-invalid={!!error}
            aria-describedby={error ? "setup-error" : undefined}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="owner-password">Password</Label>
          <div className="relative">
            <Input
              id="owner-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              className="pr-9"
              required
            />
            <button
              type="button"
              className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((current) => !current)}
            >
              {showPassword ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            You sign in with this email and password from now on. The instance's password rules apply.
          </p>
        </div>

        {error ? <FormError id="setup-error" title="Could not create the owner" message={error} /> : null}

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {pending ? "Creating the owner" : "Create owner and open the console"}
        </Button>
      </form>
    </>
  );
}

export function OwnerSetupHelp() {
  return (
    <>
      <h2 id="help-heading" className="text-[0.9375rem] font-heading tracking-[-0.01em]">
        What the owner can do
      </h2>
      <dl className="mt-4 space-y-4 text-sm">
        <div>
          <dt className="font-medium">Run the console</dt>
          <dd className="mt-0.5 text-muted-foreground">
            The owner opens this dashboard by signing in, the same way your users sign in to your apps.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Bring in other admins</dt>
          <dd className="mt-0.5 text-muted-foreground">
            Give any user the <span className="text-foreground">Administrator</span> role from their page, under Roles.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Keep the secret key as a fallback</dt>
          <dd className="mt-0.5 text-muted-foreground">
            <code className="font-data text-foreground">orbitid keys</code> still prints a key that signs in here, for
            when no account can.
          </dd>
        </div>
      </dl>
    </>
  );
}

import { CopyButton } from "./copy-button";

const START_COMMANDS = `# 1. Start the Rust server against Postgres. It prints the publishable key, never the secret.
export ORBITID_DATABASE_URL=postgres://user:password@localhost:5432/orbitid
export ORBITID_ENCRYPTION_KEY="$(openssl rand -base64 32)"
cargo run -p orbitid-server -- start

# 2. Copy the environment file, then print the keys for that same environment.
cp playground/.env.example playground/.env.local
cargo run -q -p orbitid-server -- keys

# 3. Start the test site on port 3300.
bun run --filter orbitid-playground dev`;

const ENV_ROWS: Array<{ name: string; meaning: string }> = [
  {
    name: "NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY",
    meaning: "Required. The pk_test value printed by the server. Its decoded host is the Frontend API.",
  },
  {
    name: "ORBITID_SECRET_KEY",
    meaning: "Optional. Unlocks seed data, webhook endpoint registration and session settings.",
  },
  {
    name: "ORBITID_WEBHOOK_SECRET",
    meaning: "Optional. Set it when the webhook receiver is registered in the dashboard instead of here.",
  },
  {
    name: "ORBITID_API_URL",
    meaning: "Optional. Defaults to the host inside the publishable key.",
  },
];

/**
 * Environment names are single long tokens. Break them after each underscore (the natural word
 * boundary) and let a pathological suffix wrap anywhere, so a 375px screen never splits `is / set`.
 */
function EnvName({ value }: { value: string }) {
  const parts = value.split("_");
  return (
    <code className="font-data break-words [overflow-wrap:anywhere]">
      {parts.map((part, index) => (
        <span key={`${part}-${index}`}>
          {part}
          {index < parts.length - 1 ? (
            <>
              _
              <wbr />
            </>
          ) : null}
        </span>
      ))}
    </code>
  );
}

export function CommandBlock({ commands, label }: { commands: string; label: string }) {
  return (
    <div className="border">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <CopyButton value={commands} label="Copy commands" />
      </div>
      <pre className="font-data overflow-x-auto p-3 text-xs leading-relaxed whitespace-pre-wrap text-foreground">{commands}</pre>
    </div>
  );
}

/** One compact panel for every "this needs configuration" state. Names the missing value and the fix. */
export function SetupRequired({
  title,
  description,
  missing,
}: {
  title: string;
  description: string;
  missing?: string;
}) {
  return (
    <section aria-labelledby="setup-required-title" className="border">
      <div className="border-b px-4 py-3">
        <h2 id="setup-required-title" className="text-lg">
          {title}
        </h2>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">{description}</p>
        {missing ? (
          <p className="mt-2 inline-block max-w-full border px-2 py-1 text-xs text-signal">
            <EnvName value={missing} />
          </p>
        ) : null}
      </div>
      <div className="grid items-start gap-4 p-4 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold">What to set</h3>
          <dl className="mt-2 divide-y border-y">
            {ENV_ROWS.map((row) => (
              <div key={row.name} className="min-w-0 py-1.5">
                <dt className="min-w-0 text-xs text-foreground">
                  <EnvName value={row.name} />
                </dt>
                <dd className="mt-0.5 text-xs text-muted-foreground">{row.meaning}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Values go in <code className="font-data">playground/.env.local</code>. Restart the dev server after editing
            it.
          </p>
        </div>
        <CommandBlock commands={START_COMMANDS} label="Run from the repository root" />
      </div>
    </section>
  );
}

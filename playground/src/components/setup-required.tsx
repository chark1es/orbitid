import { CopyButton } from "./copy-button";

const START_COMMANDS = `# 1. Start the server. It prints both keys once.
bun run --filter @orbitid/server start

# 2. Copy the environment file, then paste both keys into it.
cp playground/.env.example playground/.env.local

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

/** One panel for every "this needs configuration" state. Names the missing value and the fix. */
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
      <div className="border-b px-5 py-4">
        <h2 id="setup-required-title" className="text-lg">
          {title}
        </h2>
        <p className="mt-1 max-w-[70ch] text-muted-foreground">{description}</p>
        {missing ? (
          <p className="font-data mt-3 inline-block border px-2 py-1 text-xs text-signal">{missing}</p>
        ) : null}
      </div>
      <div className="grid items-start gap-5 p-5 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold">What to set</h3>
          <dl className="mt-2 divide-y border-y">
            {ENV_ROWS.map((row) => (
              <div key={row.name} className="py-2">
                <dt className="font-data text-xs text-foreground">{row.name}</dt>
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

"use client";

import * as React from "react";
import { Button, Input } from "@orbitid/ui";
import { useAuth } from "@orbitid/react";
import { StatusChip } from "../status-chip";
import { type ClientActivityInput } from "./use-client-activity";
import { buildHasProbe, describeHasResult, type HasProbeKind } from "@/lib/has";

export function HasTester({
  record,
}: {
  record: (event: ClientActivityInput) => void;
}) {
  const auth = useAuth({ treatPendingAsSignedOut: false });
  const [kind, setKind] = React.useState<HasProbeKind>("permission");
  const [value, setValue] = React.useState("org:sys_memberships:manage");
  const [checked, setChecked] = React.useState<string | null>(null);

  const probe = buildHasProbe(kind, value);
  const allowed = probe.ok ? auth.has(probe.params) : false;
  const verdict = describeHasResult(allowed);
  const permissions = auth.orgPermissions ?? [];

  function check() {
    if (!probe.ok) {
      setChecked(probe.error);
      return;
    }
    setChecked(probe.expression);
    record({
      method: "unknown",
      outcome: allowed ? "success" : "failed",
      detail: `${probe.expression} → ${verdict.word}`,
    });
  }

  return (
    <section aria-labelledby="has-title" className="border">
      <div className="border-b px-4 py-3">
        <h2 id="has-title" className="text-base">
          has() tester
        </h2>
        <p className="text-xs text-muted-foreground">
          Checks the active session claims. Exactly one of role or permission, as the SDK requires.
        </p>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Check kind">
          {(["permission", "role"] as const).map((option) => (
            <Button
              key={option}
              type="button"
              size="xs"
              variant={kind === option ? "default" : "outline"}
              aria-pressed={kind === option}
              onClick={() => {
                setKind(option);
                setValue(option === "role" ? (auth.orgRole ?? "org:admin") : "org:sys_memberships:manage");
                setChecked(null);
              }}
            >
              {option === "permission" ? "Permission" : "Role"}
            </Button>
          ))}
        </div>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            check();
          }}
        >
          <div className="flex-1">
            <label htmlFor="has-value" className="text-xs font-medium">
              {kind === "role" ? "Role" : "Permission"}
            </label>
            <Input
              id="has-value"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setChecked(null);
              }}
              className="font-data mt-1 h-8"
              placeholder={kind === "role" ? "org:admin" : "org:sys_memberships:manage"}
              autoComplete="off"
            />
          </div>
          <Button type="submit" size="sm">
            Run check
          </Button>
        </form>
        {!probe.ok ? (
          <p className="text-xs text-signal">{probe.error}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <code className="font-data rounded-sm border px-2 py-1 text-xs">{probe.expression}</code>
            <StatusChip kind={allowed ? "success" : "failed"} label={verdict.word} />
            <span className="text-xs text-muted-foreground">{verdict.detail}</span>
          </div>
        )}
        {permissions.length ? (
          <div>
            <p className="text-xs text-muted-foreground">Permissions on this session. Pick one.</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {permissions.map((permission) => (
                <Button
                  key={permission}
                  type="button"
                  size="xs"
                  variant="outline"
                  className="font-data"
                  onClick={() => {
                    setKind("permission");
                    setValue(permission);
                    setChecked(null);
                  }}
                >
                  {permission}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        {checked ? <p className="font-data text-xs text-muted-foreground">Last run: {checked}</p> : null}
      </div>
    </section>
  );
}

"use client";

import { useAuth } from "@orbitid/react";
import { useClientActivity } from "./inspector/use-client-activity";
import { SessionState } from "./inspector/session-state";
import { TokenPanel, TemplatePanel } from "./inspector/token-panels";
import { HasTester } from "./inspector/has-tester";
import { SessionsTable, ActivitySection } from "./inspector/sessions";
import { TrustedDevicesSection } from "./inspector/trusted-devices";

export function Inspector() {
  const { events, record, clear } = useClientActivity();
  const { isLoaded } = useAuth({ treatPendingAsSignedOut: false });

  return (
    <div className="space-y-8">
      {!isLoaded ? (
        <div className="border px-4 py-3" aria-busy="true">
          <div className="h-4 w-40 animate-pulse rounded-sm bg-muted" />
        </div>
      ) : null}
      <SessionState />
      <TokenPanel record={record} />
      <TemplatePanel record={record} />
      <HasTester record={record} />
      <SessionsTable />
      <TrustedDevicesSection />
      <ActivitySection record={record} events={events} clear={clear} />
    </div>
  );
}

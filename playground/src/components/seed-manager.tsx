"use client";

import * as React from "react";
import { Button, Input } from "@orbitid/ui";
import { CopyButton } from "./copy-button";
import { StatusChip } from "./status-chip";
import type { ActionResult } from "@/lib/action-state";
import type { PlaygroundUser } from "@/lib/seed-types";
import { formatDateTime } from "@/lib/format";
import {
  createTestUsers,
  createTicket,
  deleteAllPlaygroundUsers,
  deletePlaygroundUser,
} from "@/app/seed/actions";

const INITIAL: ActionResult = { ok: false, message: "" };

function Feedback({ state }: { state: ActionResult }) {
  if (!state.message) return null;
  return (
    <div className="mt-2 text-xs" role="status">
      <StatusChip kind={state.ok ? "success" : "failed"} label={state.ok ? "Done" : "Failed"} />
      <p className={`mt-1 text-sm ${state.ok ? "text-foreground" : "text-signal"}`}>{state.message}</p>
      {state.detail ? <p className="mt-0.5 text-muted-foreground">{state.detail}</p> : null}
    </div>
  );
}

function UserActions({
  user,
  deleteAction,
  deleting,
}: {
  user: PlaygroundUser;
  deleteAction: (formData: FormData) => void;
  deleting: boolean;
}) {
  const [ticketState, ticketAction, sendingTicket] = React.useActionState(createTicket, INITIAL);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2">
        <form action={ticketAction}>
          <input type="hidden" name="userId" value={user.id} />
          <Button type="submit" variant="outline" size="xs" disabled={sendingTicket}>
            {sendingTicket ? "Creating link" : "Create sign-in link"}
          </Button>
        </form>
        <form action={deleteAction}>
          <input type="hidden" name="userId" value={user.id} />
          <Button
            type="submit"
            variant="ghost"
            size="xs"
            className="text-signal hover:bg-signal/10 hover:text-signal"
            aria-label={`Delete ${user.email}`}
            disabled={deleting}
          >
            {deleting ? "Deleting" : "Delete"}
          </Button>
        </form>
      </div>
      {ticketState.href ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button asChild size="xs">
            <a href={ticketState.href}>Sign in as</a>
          </Button>
          <CopyButton value={ticketState.href} label="Copy link" />
        </div>
      ) : null}
      <Feedback state={ticketState} />
    </div>
  );
}

export function SeedManager({
  users,
  loadError,
  scanned,
}: {
  users: PlaygroundUser[];
  loadError?: string;
  scanned?: number;
}) {
  const [createState, createAction, creating] = React.useActionState(createTestUsers, INITIAL);
  const [deleteAllState, deleteAllAction, deletingAll] = React.useActionState(deleteAllPlaygroundUsers, INITIAL);
  const [deleteState, deleteAction, deleting] = React.useActionState(deletePlaygroundUser, INITIAL);
  const scannedDetail =
    scanned === 1
      ? ", from the newest user the instance returned"
      : scanned
        ? `, from the ${scanned} newest users the instance returned`
        : "";

  return (
    <div className="space-y-8">
      <section aria-labelledby="create-users-title" className="border">
        <div className="border-b px-4 py-3">
          <h2 id="create-users-title" className="text-base">
            Create test users
          </h2>
          <p className="text-xs text-muted-foreground">
            Calls the Backend API. Each user gets a random name, a unique address at playground.test and public_metadata
            {" "}
            {"{ playground: true }"}.
          </p>
        </div>
        <form action={createAction} className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          <div>
            <label htmlFor="seed-count" className="text-xs font-medium">
              How many users
            </label>
            <Input
              id="seed-count"
              name="count"
              type="number"
              min={1}
              max={10}
              defaultValue={3}
              required
              className="mt-1 h-8 w-28"
            />
          </div>
          <div>
            <label htmlFor="seed-password" className="text-xs font-medium">
              Password for every user
            </label>
            <Input
              id="seed-password"
              name="password"
              type="text"
              defaultValue="OrbitidTest123!"
              required
              minLength={8}
              autoComplete="off"
              className="font-data mt-1 h-8"
            />
            <p className="mt-1 text-xs text-muted-foreground">The instance policy may require more than 8 characters.</p>
          </div>
          <div>
            <label htmlFor="seed-org" className="text-xs font-medium">
              Organization name (optional)
            </label>
            <Input
              id="seed-org"
              name="organizationName"
              type="text"
              placeholder="Playground team"
              autoComplete="off"
              className="mt-1 h-8"
            />
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="withOrganization" defaultChecked className="size-4 accent-primary" />
              Create an organization and add these users
            </label>
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" size="sm" disabled={creating}>
              {creating ? "Creating users" : "Create users"}
            </Button>
            <Feedback state={createState} />
          </div>
        </form>
      </section>

      <section aria-labelledby="playground-users-title" className="border">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
          <div>
            <h2 id="playground-users-title" className="text-base">
              Playground users
            </h2>
            <p className="text-xs text-muted-foreground">
              {users.length} marked user{users.length === 1 ? "" : "s"}
              {scannedDetail}. Only these can be deleted here. If the signed-in user carries the marker, deleting it
              ends this session.
            </p>
          </div>
          <form action={deleteAllAction}>
            <Button
              type="submit"
              variant="outline"
              size="xs"
              className="text-signal"
              disabled={deletingAll || users.length === 0}
            >
              {deletingAll ? "Deleting all" : `Delete all ${users.length}`}
            </Button>
          </form>
        </div>
        <div className="px-4 pt-3">
          <Feedback state={deleteAllState} />
          <Feedback state={deleteState} />
        </div>

        {loadError ? (
          <div className="px-4 py-4" role="alert">
            <StatusChip kind="failed" label="Could not list users" />
            <p className="mt-1 text-sm text-signal">{loadError}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Check ORBITID_SECRET_KEY and that the instance is running, then reload this page.
            </p>
          </div>
        ) : users.length === 0 ? (
          <div className="px-4 py-4">
            <p className="text-sm">No playground users yet.</p>
            <p className="mt-1 max-w-[65ch] text-xs text-muted-foreground">
              Create a batch above. The tool marks them so it can list and delete exactly the users it made.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Users created by this playground</caption>
            <thead className="hidden sm:table-header-group">
              <tr className="border-y text-left">
                <th scope="col" className="px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  User
                </th>
                <th scope="col" className="hidden px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase lg:table-cell">
                  Created
                </th>
                <th scope="col" className="px-4 py-2 text-right text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {users.map((user) => (
                <tr key={user.id} className="align-top">
                  <td className="px-4 py-2.5">
                    <p className="text-sm">
                      {[user.firstName, user.lastName].filter(Boolean).join(" ") || "No name"}
                    </p>
                    <p className="font-data text-xs break-all text-muted-foreground">{user.email}</p>
                    <p className="font-data text-[0.6875rem] text-muted-foreground">{user.id}</p>
                  </td>
                  <td className="font-data hidden px-4 py-2.5 text-xs text-muted-foreground lg:table-cell">
                    {user.createdAt ? formatDateTime(user.createdAt) : "Unknown"}
                  </td>
                  <td className="px-4 py-2.5">
                    <UserActions user={user} deleteAction={deleteAction} deleting={deleting} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

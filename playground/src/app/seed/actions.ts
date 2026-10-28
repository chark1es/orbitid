"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-state";
import { createBackend, currentOrigin, readSecretKey } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { makeSeedIdentity } from "@/lib/seed";
import { primaryEmailOf } from "@/lib/user";

const NO_SECRET: ActionResult = {
  ok: false,
  message: "ORBITID_SECRET_KEY is not set.",
  detail: "Add it to playground/.env.local, restart the dev server, then reload this page.",
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export async function createTestUsers(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const secretKey = readSecretKey();
  if (!secretKey) return NO_SECRET;

  const count = Number(formData.get("count"));
  const password = String(formData.get("password") ?? "");
  const organizationName = String(formData.get("organizationName") ?? "").trim();
  const withOrganization = formData.get("withOrganization") === "on";

  if (!Number.isInteger(count) || count < 1 || count > 10) {
    return {
      ok: false,
      message: "Choose between 1 and 10 users.",
      detail: "The form caps the batch so a click cannot flood the instance.",
    };
  }
  if (password.length < 8) {
    return {
      ok: false,
      message: "The password is shorter than 8 characters.",
      detail: "The instance password policy may require more: length, case, a number or a symbol.",
    };
  }

  const backend = createBackend();
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 6);
  const failures: string[] = [];
  const created: Array<{ id: string; email: string }> = [];

  for (let index = 0; index < count; index += 1) {
    const identity = makeSeedIdentity(index, `${suffix}${index}`);
    try {
      const user = await backend.users.createUser({
        emailAddress: [identity.email],
        password,
        firstName: identity.firstName,
        lastName: identity.lastName,
        publicMetadata: { playground: true },
      });
      created.push({ id: user.id, email: identity.email });
    } catch (error) {
      failures.push(`${identity.email}: ${describeError(error)}`);
    }
  }

  let organizationLine = "";
  if (withOrganization && created.length > 0) {
    const name = organizationName || `Playground ${suffix.slice(0, 4).toUpperCase()}`;
    try {
      const organization = await backend.organizations.createOrganization({
        name,
        slug: `${slugify(name)}-${suffix.slice(0, 4)}`,
        maxAllowedMemberships: 10,
      });
      const memberFailures: string[] = [];
      for (const [index, user] of created.entries()) {
        try {
          await backend.organizations.createOrganizationMembership({
            organizationId: organization.id,
            userId: user.id,
            role: index === 0 ? "org:admin" : "org:member",
          });
        } catch (error) {
          memberFailures.push(`${user.email}: ${describeError(error)}`);
        }
      }
      organizationLine = ` Added ${created.length - memberFailures.length} members to ${organization.name}.`;
      failures.push(...memberFailures);
    } catch (error) {
      failures.push(`Organization ${name}: ${describeError(error)}`);
    }
  }

  revalidatePath("/seed");
  const summary = `Created ${created.length} of ${count} users`;
  return {
    ok: created.length > 0 && failures.length === 0,
    message: `${summary}.${organizationLine}`,
    detail:
      failures.length === 0
        ? `Sign in with any address below and the password you chose. Marked with public_metadata { playground: true }.`
        : failures.join(" · "),
  };
}

export async function deletePlaygroundUser(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!readSecretKey()) return NO_SECRET;
  const userId = String(formData.get("userId") ?? "").trim();
  if (!userId) return { ok: false, message: "No user id was sent." };

  try {
    const backend = createBackend();
    const user = await backend.users.getUser(userId);
    if (user.publicMetadata?.playground !== true) {
      return {
        ok: false,
        message: "That user is not marked as a playground user.",
        detail: "This page deletes only users with public_metadata { playground: true }.",
      };
    }
    await backend.users.deleteUser(userId);
    revalidatePath("/seed");
    return { ok: true, message: `Deleted ${primaryEmailOf(user) ?? userId}.` };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function deleteAllPlaygroundUsers(_previous: ActionResult, _formData: FormData): Promise<ActionResult> {
  if (!readSecretKey()) return NO_SECRET;
  try {
    const backend = createBackend();
    const result = await backend.users.getUserList({ limit: 100, orderBy: "-created_at" });
    const targets = result.data.filter((user) => user.publicMetadata?.playground === true);
    let deleted = 0;
    const failures: string[] = [];
    for (const user of targets) {
      try {
        await backend.users.deleteUser(user.id);
        deleted += 1;
      } catch (error) {
        failures.push(`${user.id}: ${describeError(error)}`);
      }
    }
    revalidatePath("/seed");
    return {
      ok: failures.length === 0,
      message: `Deleted ${deleted} of ${targets.length} playground users.`,
      detail: failures.length ? failures.join(" · ") : "Organizations these users created keep their other members.",
    };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function createTicket(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!readSecretKey()) return NO_SECRET;
  const userId = String(formData.get("userId") ?? "").trim();
  if (!userId) return { ok: false, message: "No user id was sent." };

  try {
    const backend = createBackend();
    const user = await backend.users.getUser(userId);
    if (user.publicMetadata?.playground !== true) {
      return {
        ok: false,
        message: "That user is not marked as a playground user.",
        detail: "Create a user on this page, then request a sign-in link for it.",
      };
    }
    const token = await backend.signInTokens.createSignInToken({ userId, expiresInSeconds: 600 });
    if (!token.token) {
      return { ok: false, message: "The instance created a token but did not return it." };
    }
    const href = `${await currentOrigin()}/sign-in?__orbit_ticket=${encodeURIComponent(token.token)}`;
    revalidatePath("/seed");
    return {
      ok: true,
      message: `Sign-in link for ${primaryEmailOf(user) ?? user.id}.`,
      detail: "The SignIn component redeems the ticket on load. It works once and expires in 10 minutes.",
      href,
    };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

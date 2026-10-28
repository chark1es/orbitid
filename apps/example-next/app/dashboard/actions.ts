"use server";

import { revalidatePath } from "next/cache";
import { auth, orbitIdClient } from "@orbitid/nextjs/server";

export async function updateDisplayName(formData: FormData) {
  const session = await auth();
  if (!session.userId) throw new Error("Unauthorized");

  const firstName = String(formData.get("firstName") ?? "").trim();
  if (!firstName) throw new Error("First name is required");

  await orbitIdClient().users.updateUser(session.userId, { firstName });
  revalidatePath("/dashboard");
}

/** Shared constants for the backend route group. */
import { pathParam } from "../../operation";

export const userId = pathParam("id", "User id (`user_…`).");

/** Array filter parameters the user list accepts; repeated, comma separated and single values all work. */
export const multi = (name: string, description: string) => ({ name, in: "query" as const, description, schema: { type: "array", items: { type: "string" } } });

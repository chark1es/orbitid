/**
 * Shared building blocks reused by the schema groups.
 */
import { deletedObject, int, type Schema } from "../schema";

export const timestamps = { created_at: int({ description: "Epoch milliseconds." }), updated_at: int({ description: "Epoch milliseconds." }) };

export const deletion: Schema = deletedObject("resource");

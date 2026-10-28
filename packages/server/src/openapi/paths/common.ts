/** Response helpers shared by the path modules. */
import { arr, deletedObject, fapi, obj, ref, type Schema } from "../schema";

export const ok = (schema: Schema) => ({ success: { status: 200 as const, schema } });

/** `{ response: T }`, the Frontend API envelope. */
export const fapiOk = (schema: Schema) => ok(fapi(schema));

/** `{ response: T, client: Client }` — sign-in, sign-up and session mutations also return the updated client. */
export const fapiWithClient = (schema: Schema) => ok(obj({ response: schema, client: ref("Client") }));

export const deleted = (object: string) => ok(deletedObject(object));

/** Backend API list envelope: `{ data: T[], total_count: number }`. */
export const list = (item: Schema) => ({ success: { status: 200 as const, schema: obj({ data: arr(item), total_count: { type: "integer" } }) } });

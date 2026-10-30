/**
 * Machine-to-machine, API key, and machine token schemas.
 */
import { timestamps } from "./shared";
import { arr, bool, freeObject, int, lit, nullable, obj, opt, str, type Schema } from "../schema";

export const apiKey: Schema = obj({
  object: lit("api_key"),
  id: str(),
  name: str(),
  description: nullable(str()),
  subject: str({ description: "Owner of the key: `user_…` or `org_…`." }),
  prefix: str(),
  secret: opt(str({ description: "`ak_live_…` secret. Returned once, when the key is created." })),
  scopes: arr(str()),
  claims: nullable(freeObject()),
  revoked: bool(),
  expiration: nullable(int()),
  last_used_at: nullable(int()),
  created_by: nullable(str()),
  ...timestamps,
});

export const machine: Schema = obj({
  object: lit("machine"),
  id: str(),
  name: str(),
  scoped_machines: arr(str()),
  default_token_ttl: int({ description: "Seconds." }),
  ...timestamps,
});

export const machineToken: Schema = obj({
  object: lit("machine_token"),
  id: str(),
  machine_id: str(),
  token: opt(str({ description: "Opaque `mt_…` token or JWT, returned only from the creating request." })),
  claims: nullable(freeObject()),
  revoked: bool(),
  expired: bool(),
  expiration: nullable(int()),
  created_at: int(),
});

/**
 * Webhook endpoint and delivery schemas.
 */
import { WEBHOOK_EVENT_TYPES } from "@orbitid/shared";
import { timestamps } from "./shared";
import { arr, bool, enm, int, lit, nullable, obj, opt, str, type Schema } from "../schema";

export const webhookEndpoint: Schema = obj({
  object: lit("webhook_endpoint"),
  id: str(),
  url: str({ format: "uri" }),
  description: str(),
  event_types: arr(enm(WEBHOOK_EVENT_TYPES)),
  disabled: bool(),
  secret: opt(str({ description: "`whsec_…` signing secret. Returned on create, on rotate and from `GET …/secret` only." })),
  ...timestamps,
});

export const webhookDelivery: Schema = obj({
  object: lit("webhook_delivery"),
  id: str(),
  endpoint_id: str(),
  event_id: str(),
  event_type: str(),
  status: enm(["pending", "success", "failed"]),
  attempt: int(),
  response_code: nullable(int()),
  response_body: nullable(str()),
  next_attempt_at: nullable(int()),
  created_at: int(),
});

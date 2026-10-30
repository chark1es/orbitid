/** Request schemas for the signed-in user routes. */
import { z } from "zod";
import { MAX_UPLOAD_BYTES } from "../../lib/http";
import { zBool, zMetadata } from "../auth/forms";

export const optionalName = z.string().max(256).nullish();
export const updateSchema = z.object({
  first_name: optionalName,
  last_name: optionalName,
  username: z.string().max(64).nullish(),
  unsafe_metadata: zMetadata.optional(),
  primary_email_address_id: z.string().max(64).nullish(),
  primary_phone_number_id: z.string().max(64).nullish(),
  legal_accepted: zBool.optional(),
});
export const passwordChangeSchema = z.object({ current_password: z.string().max(256).optional(), new_password: z.string().max(256), sign_out_of_other_sessions: z.boolean().optional() });
export const passwordRemoveSchema = z.object({ current_password: z.string().max(256) });
export const emailCreateSchema = z.object({ email_address: z.string().max(320) });
export const phoneCreateSchema = z.object({ phone_number: z.string().max(32) });
export const phoneUpdateSchema = z.object({ reserved_for_second_factor: zBool.optional(), default_second_factor: zBool.optional() });
export const verifyCodeSchema = z.object({ code: z.string().max(64), strategy: z.string().max(64).optional() });
export const prepareSchema = z.object({ strategy: z.string().max(64).optional() });
export const externalAccountCreateSchema = z.object({
  strategy: z.string().max(64), redirect_url: z.string().max(2048).optional(), additional_scopes: z.array(z.string().max(256)).max(50).optional(),
});
export const totpAttemptSchema = z.object({ code: z.string().max(64) });
export const passkeyCreateSchema = z.object({ name: z.string().max(128).optional(), authenticator_type: z.enum(["platform", "cross-platform"]).optional() });
export const passkeyAttemptSchema = z.object({ public_key_credential: z.unknown(), name: z.string().max(128).optional() });
export const passkeyRenameSchema = z.object({ name: z.string().min(1).max(128) });
export const MAX_IMAGE_BYTES = MAX_UPLOAD_BYTES;
export const imageSchema = z.object({ file: z.string().max(MAX_IMAGE_BYTES) });

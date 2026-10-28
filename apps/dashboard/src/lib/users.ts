import { parseJsonObject } from "./format";

export interface CreateUserForm {
  email: string;
  phone: string;
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  externalId: string;
  publicMetadata: string;
  privateMetadata: string;
  unsafeMetadata: string;
  skipPasswordChecks: boolean;
}

export interface CreateUserPayload {
  email_address?: string[];
  phone_number?: string[];
  username?: string;
  password?: string;
  first_name?: string;
  last_name?: string;
  external_id?: string;
  public_metadata?: Record<string, unknown>;
  private_metadata?: Record<string, unknown>;
  unsafe_metadata?: Record<string, unknown>;
  skip_password_checks?: boolean;
}

export const emptyCreateUserForm = (): CreateUserForm => ({
  email: "",
  phone: "",
  username: "",
  password: "",
  firstName: "",
  lastName: "",
  externalId: "",
  publicMetadata: "",
  privateMetadata: "",
  unsafeMetadata: "",
  skipPasswordChecks: false,
});

function metadataField(text: string, label: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  const parsed = parseJsonObject(text);
  if (!parsed.ok) throw new Error(`${label}: ${parsed.error}`);
  return parsed.value;
}

/**
 * Maps the create-user dialog to the Clerk-compatible `POST /v1/users` body: blank inputs are omitted
 * (not sent as empty strings) and metadata is parsed once, here, so the dialog stays declarative.
 */
export function buildCreateUserPayload(form: CreateUserForm): CreateUserPayload {
  const payload: CreateUserPayload = {};
  const email = form.email.trim();
  const phone = form.phone.trim();
  const username = form.username.trim();
  const firstName = form.firstName.trim();
  const lastName = form.lastName.trim();
  const externalId = form.externalId.trim();

  if (email) payload.email_address = [email];
  if (phone) payload.phone_number = [phone];
  if (username) payload.username = username;
  if (form.password) payload.password = form.password;
  if (firstName) payload.first_name = firstName;
  if (lastName) payload.last_name = lastName;
  if (externalId) payload.external_id = externalId;

  const publicMetadata = metadataField(form.publicMetadata, "Public metadata");
  const privateMetadata = metadataField(form.privateMetadata, "Private metadata");
  const unsafeMetadata = metadataField(form.unsafeMetadata, "Unsafe metadata");
  if (publicMetadata) payload.public_metadata = publicMetadata;
  if (privateMetadata) payload.private_metadata = privateMetadata;
  if (unsafeMetadata) payload.unsafe_metadata = unsafeMetadata;
  if (form.skipPasswordChecks) payload.skip_password_checks = true;

  return payload;
}

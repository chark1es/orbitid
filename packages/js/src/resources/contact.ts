import type { EmailAddressJSON, PhoneNumberJSON, UserJSON } from "@orbitid/shared";
import type { FapiClient } from "../fapi";
import { fetchData } from "./base";
import { Verification } from "./verification";

export class EmailAddress {
  readonly object = "email_address" as const;
  id: string;
  emailAddress: string;
  verification: Verification | null;
  linkedTo: { type: string; id: string }[];
  reserved: boolean;
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: EmailAddressJSON,
    private readonly onUserUpdated?: (json: UserJSON) => void,
  ) {
    this.id = json.id;
    this.emailAddress = json.email_address;
    this.verification = Verification.fromJSON(json.verification);
    this.linkedTo = json.linked_to ?? [];
    this.reserved = json.reserved ?? false;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: EmailAddressJSON, onUserUpdated?: (json: UserJSON) => void): EmailAddress {
    return new EmailAddress(fapi, json, onUserUpdated);
  }

  get isVerified(): boolean {
    return this.verification?.status === "verified";
  }

  private applyJSON(json: EmailAddressJSON): this {
    this.emailAddress = json.email_address;
    this.verification = Verification.fromJSON(json.verification) ?? this.verification;
    this.updatedAt = json.updated_at;
    return this;
  }

  async prepareVerification({ strategy = "email_code" }: { strategy?: string } = {}): Promise<this> {
    const json = await fetchData<EmailAddressJSON>(this.fapi, "POST", `/v1/client/me/email_addresses/${this.id}/prepare_verification`, {
      body: { strategy },
    });
    return this.applyJSON(json);
  }

  async attemptVerification({ code }: { code: string }): Promise<this> {
    const json = await fetchData<EmailAddressJSON>(this.fapi, "POST", `/v1/client/me/email_addresses/${this.id}/attempt_verification`, {
      body: { code },
    });
    return this.applyJSON(json);
  }

  /** Makes this address the user's primary one (`PATCH /me`). */
  async setAsPrimary(): Promise<this> {
    const json = await fetchData<UserJSON>(this.fapi, "PATCH", "/v1/client/me", { body: { primary_email_address_id: this.id } });
    this.onUserUpdated?.(json);
    const updated = (json.email_addresses ?? []).find((email) => email.id === this.id);
    return updated ? this.applyJSON(updated) : this;
  }

  async destroy(): Promise<void> {
    await this.fapi.del(`/v1/client/me/email_addresses/${this.id}`);
  }
}

export interface PhoneNumberParams {
  reservedForSecondFactor?: boolean;
  defaultSecondFactor?: boolean;
}

export class PhoneNumber {
  readonly object = "phone_number" as const;
  id: string;
  phoneNumber: string;
  reservedForSecondFactor: boolean;
  defaultSecondFactor: boolean;
  verification: Verification | null;
  linkedTo: { type: string; id: string }[];
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: PhoneNumberJSON,
    private readonly onUserUpdated?: (json: UserJSON) => void,
  ) {
    this.id = json.id;
    this.phoneNumber = json.phone_number;
    this.reservedForSecondFactor = json.reserved_for_second_factor ?? false;
    this.defaultSecondFactor = json.default_second_factor ?? false;
    this.verification = Verification.fromJSON(json.verification);
    this.linkedTo = json.linked_to ?? [];
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: PhoneNumberJSON, onUserUpdated?: (json: UserJSON) => void): PhoneNumber {
    return new PhoneNumber(fapi, json, onUserUpdated);
  }

  get isVerified(): boolean {
    return this.verification?.status === "verified";
  }

  private applyJSON(json: PhoneNumberJSON): this {
    this.phoneNumber = json.phone_number;
    this.reservedForSecondFactor = json.reserved_for_second_factor ?? this.reservedForSecondFactor;
    this.defaultSecondFactor = json.default_second_factor ?? this.defaultSecondFactor;
    this.verification = Verification.fromJSON(json.verification) ?? this.verification;
    this.updatedAt = json.updated_at;
    return this;
  }

  async prepareVerification({ strategy = "phone_code" }: { strategy?: string } = {}): Promise<this> {
    const json = await fetchData<PhoneNumberJSON>(this.fapi, "POST", `/v1/client/me/phone_numbers/${this.id}/prepare_verification`, {
      body: { strategy },
    });
    return this.applyJSON(json);
  }

  async attemptVerification({ code }: { code: string }): Promise<this> {
    const json = await fetchData<PhoneNumberJSON>(this.fapi, "POST", `/v1/client/me/phone_numbers/${this.id}/attempt_verification`, {
      body: { code },
    });
    return this.applyJSON(json);
  }

  async setReservedForSecondFactor({ reserved }: { reserved: boolean }): Promise<this> {
    const json = await fetchData<PhoneNumberJSON>(this.fapi, "PATCH", `/v1/client/me/phone_numbers/${this.id}`, {
      body: { reserved_for_second_factor: reserved },
    });
    return this.applyJSON(json);
  }

  async makeDefaultSecondFactor(): Promise<this> {
    const json = await fetchData<PhoneNumberJSON>(this.fapi, "PATCH", `/v1/client/me/phone_numbers/${this.id}`, {
      body: { default_second_factor: true },
    });
    return this.applyJSON(json);
  }

  async setAsPrimary(): Promise<this> {
    const json = await fetchData<UserJSON>(this.fapi, "PATCH", "/v1/client/me", { body: { primary_phone_number_id: this.id } });
    this.onUserUpdated?.(json);
    const updated = (json.phone_numbers ?? []).find((phone) => phone.id === this.id);
    return updated ? this.applyJSON(updated) : this;
  }

  async destroy(): Promise<void> {
    await this.fapi.del(`/v1/client/me/phone_numbers/${this.id}`);
  }
}

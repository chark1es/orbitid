import type { OrganizationDomainJSON } from "@orbitid/shared";
import type { FapiClient } from "../fapi";
import { fetchData } from "./base";
import { Verification } from "./verification";

export class OrganizationDomain {
  readonly object = "organization_domain" as const;
  id: string;
  organizationId: string;
  name: string;
  enrollmentMode: "manual_invitation" | "automatic_invitation" | "automatic_suggestion";
  verification: Verification | null;
  affiliationEmailAddress: string | null;
  totalPendingInvitations: number;
  totalPendingSuggestions: number;
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: OrganizationDomainJSON,
    organizationId?: string,
  ) {
    this.id = json.id;
    this.organizationId = json.organization_id ?? organizationId ?? "";
    this.name = json.name;
    this.enrollmentMode = json.enrollment_mode;
    this.verification = Verification.fromJSON(json.verification);
    this.affiliationEmailAddress = json.affiliation_email_address ?? null;
    this.totalPendingInvitations = json.total_pending_invitations ?? 0;
    this.totalPendingSuggestions = json.total_pending_suggestions ?? 0;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: OrganizationDomainJSON, organizationId?: string): OrganizationDomain {
    return new OrganizationDomain(fapi, json, organizationId);
  }

  get isVerified(): boolean {
    return this.verification?.status === "verified";
  }

  private applyJSON(json: OrganizationDomainJSON): this {
    this.enrollmentMode = json.enrollment_mode;
    this.verification = Verification.fromJSON(json.verification) ?? this.verification;
    this.affiliationEmailAddress = json.affiliation_email_address ?? this.affiliationEmailAddress;
    this.updatedAt = json.updated_at;
    return this;
  }

  async prepareAffiliationVerification(params: { affiliationEmailAddress: string }): Promise<this> {
    const json = await fetchData<OrganizationDomainJSON>(
      this.fapi,
      "POST",
      `/v1/client/organizations/${this.organizationId}/domains/${this.id}/prepare_affiliation_verification`,
      { body: { affiliation_email_address: params.affiliationEmailAddress } },
    );
    return this.applyJSON(json);
  }

  async attemptAffiliationVerification(params: { code: string }): Promise<this> {
    const json = await fetchData<OrganizationDomainJSON>(
      this.fapi,
      "POST",
      `/v1/client/organizations/${this.organizationId}/domains/${this.id}/attempt_affiliation_verification`,
      { body: { code: params.code } },
    );
    return this.applyJSON(json);
  }

  async updateEnrollmentMode(params: { enrollmentMode: string; deletePending?: boolean }): Promise<this> {
    const json = await fetchData<OrganizationDomainJSON>(
      this.fapi,
      "POST",
      `/v1/client/organizations/${this.organizationId}/domains/${this.id}/update_enrollment_mode`,
      { body: { enrollment_mode: params.enrollmentMode, delete_pending: params.deletePending } },
    );
    return this.applyJSON(json);
  }

  async delete(): Promise<void> {
    await this.fapi.del(`/v1/client/organizations/${this.organizationId}/domains/${this.id}`);
  }
}

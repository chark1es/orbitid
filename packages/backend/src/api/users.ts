import type { BackendHttp } from "../http";
import type {
  DeletedObject,
  ListParams,
  OrganizationMembership,
  PasswordHasher,
  TrustedDevice,
  User,
  UserRoles,
  VerifyPasswordResult,
  VerifyTOTPResult,
} from "../types";
import type { Metadata } from "@orbitid/shared";
import { list, type UpdateMetadataParams } from "./shared";

export interface UserListParams extends ListParams {
  emailAddress?: string[];
  phoneNumber?: string[];
  username?: string[];
  externalId?: string[];
  userId?: string[];
}

export interface CreateUserParams {
  emailAddress?: string[];
  phoneNumber?: string[];
  username?: string;
  password?: string;
  /** Pre-hashed password for an import. Requires `passwordHasher`; the server refuses one without it. */
  passwordDigest?: string;
  /** Hasher that produced `passwordDigest`; must be one the server can verify. */
  passwordHasher?: PasswordHasher;
  firstName?: string;
  lastName?: string;
  externalId?: string;
  publicMetadata?: Metadata;
  privateMetadata?: Metadata;
  unsafeMetadata?: Metadata;
  skipPasswordChecks?: boolean;
  skipPasswordRequirement?: boolean;
  createdAt?: string;
}

export interface UpdateUserParams {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  /**
   * Refused (`403`): the Backend API cannot set or replace a user's password, so an operator cannot learn one.
   * The user calls `/me/change_password` from their own session.
   */
  password?: string;
  /** Refused (`403`): the user moves their own primary email after verifying it (`PATCH /me`). */
  primaryEmailAddressId?: string | null;
  /** Refused (`403`): the user moves their own primary phone after verifying it (`PATCH /me`). */
  primaryPhoneNumberId?: string | null;
  externalId?: string | null;
  publicMetadata?: Metadata;
  privateMetadata?: Metadata;
  unsafeMetadata?: Metadata;
  /** Only meaningful for provisioning (`createUser`); password updates are refused. */
  skipPasswordChecks?: boolean;
}

export function createUsersApi(http: BackendHttp) {
  return {
    getUserList(params: UserListParams = {}) {
      return list<User>(http, "/v1/users", {
        limit: params.limit,
        offset: params.offset,
        order_by: params.orderBy,
        query: params.query,
        paginated: true,
        email_address: params.emailAddress,
        phone_number: params.phoneNumber,
        username: params.username,
        external_id: params.externalId,
        user_id: params.userId,
      });
    },
    getUser(userId: string) {
      return http.get<User>(`/v1/users/${userId}`);
    },
    createUser(params: CreateUserParams) {
      return http.post<User>("/v1/users", { body: params });
    },
    updateUser(userId: string, params: UpdateUserParams) {
      return http.patch<User>(`/v1/users/${userId}`, { body: params });
    },
    deleteUser(userId: string) {
      return http.delete<DeletedObject>(`/v1/users/${userId}`);
    },
    banUser(userId: string) {
      return http.post<User>(`/v1/users/${userId}/ban`);
    },
    unbanUser(userId: string) {
      return http.post<User>(`/v1/users/${userId}/unban`);
    },
    lockUser(userId: string) {
      return http.post<User>(`/v1/users/${userId}/lock`);
    },
    unlockUser(userId: string) {
      return http.post<User>(`/v1/users/${userId}/unlock`);
    },
    updateUserMetadata(userId: string, params: UpdateMetadataParams) {
      return http.patch<User>(`/v1/users/${userId}/metadata`, { body: params });
    },
    /** Removed: always answers `403 not_allowed_access`. The sign-in flow verifies credentials with failure accounting. */
    verifyPassword(params: { userId: string; password: string }) {
      return http.post<VerifyPasswordResult>(`/v1/users/${params.userId}/verify_password`, { body: { password: params.password } });
    },
    /** Removed: always answers `403 not_allowed_access`. The sign-in flow verifies codes with failure accounting. */
    verifyTOTP(params: { userId: string; code: string }) {
      return http.post<VerifyTOTPResult>(`/v1/users/${params.userId}/verify_totp`, { body: { code: params.code } });
    },
    /** Removed: always answers `403 not_allowed_access`. The user disables MFA from their own session. */
    disableUserMFA(userId: string) {
      return http.delete<User>(`/v1/users/${userId}/mfa`);
    },
    uploadUserProfileImage(userId: string, file: Blob) {
      const formData = new FormData();
      formData.append("file", file);
      return http.post<User>(`/v1/users/${userId}/profile_image`, { formData });
    },
    deleteUserProfileImage(userId: string) {
      return http.delete<User>(`/v1/users/${userId}/profile_image`);
    },
    getUserOrganizationMembershipList(params: { userId: string } & ListParams) {
      return list<OrganizationMembership>(http, `/v1/users/${params.userId}/organization_memberships`, {
        limit: params.limit,
        offset: params.offset,
      });
    },
    getUserRoles(userId: string) {
      return http.get<UserRoles>(`/v1/users/${userId}/roles`);
    },
    /** Trusted devices (MFA "remember this browser") for a user, newest first. */
    getUserTrustedDeviceList(params: { userId: string }) {
      return http.get<TrustedDevice[]>(`/v1/users/${params.userId}/trusted_devices`);
    },
    /** Forces the browser to complete its second factor on the next sign-in. */
    revokeUserTrustedDevice(params: { userId: string; deviceId: string }) {
      return http.delete<DeletedObject>(`/v1/users/${params.userId}/trusted_devices/${params.deviceId}`);
    },
    /**
     * Replaces a user's instance-wide (`app:...`) roles. Operator-only, and independent of any organization:
     * organization roles are assigned through a membership. This is an explicit assignment, so the instance default
     * role no longer applies (an empty list means "no instance roles"). The next minted token carries the new
     * `roles` / `role_permissions` claims; tokens already issued keep theirs until they expire.
     */
    setUserRoles(userId: string, roles: string[]) {
      return http.put<UserRoles>(`/v1/users/${userId}/roles`, { body: { roles } });
    },
    /**
     * Drops the user's explicit instance-role assignment so they inherit the instance default role
     * (`roles.defaultRole`) again. The result has `source: "default"`.
     */
    resetUserRoles(userId: string) {
      return http.delete<UserRoles>(`/v1/users/${userId}/roles`);
    },
    /** Removed: always answers `403 not_allowed_access`. The user reads their own token from their session. */
    getUserOauthAccessToken(params: { userId: string; provider: string }) {
      return http.get<{ token: string | null; provider: string }>(`/v1/users/${params.userId}/oauth_access_tokens/${params.provider}`);
    },
    getCount(params: Omit<UserListParams, "limit" | "offset" | "orderBy"> = {}) {
      return http.get<{ totalCount: number }>("/v1/users/count", {
        query: {
          query: params.query,
          email_address: params.emailAddress,
          phone_number: params.phoneNumber,
          username: params.username,
          external_id: params.externalId,
          user_id: params.userId,
        },
      });
    },
  };
}

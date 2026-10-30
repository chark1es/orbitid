import type { BackendHttp } from "../http";
import type { DeletedObject, EmailAddress, PhoneNumber } from "../types";

/**
 * Backend email-address helpers. Reads work; every write answers `403 not_allowed_access`, because an address the
 * operator can attach, verify or delete is a sign-in identifier they control. The user manages them from their own
 * session (`/v1/client/me/email_addresses`).
 */
export function createEmailAddressesApi(http: BackendHttp) {
  return {
    createEmailAddress(params: { userId: string; emailAddress: string; verified?: boolean; primary?: boolean }) {
      return http.post<EmailAddress>("/v1/email_addresses", { body: params });
    },
    getEmailAddress(emailAddressId: string) {
      return http.get<EmailAddress>(`/v1/email_addresses/${emailAddressId}`);
    },
    updateEmailAddress(emailAddressId: string, params: { verified?: boolean; primary?: boolean }) {
      return http.patch<EmailAddress>(`/v1/email_addresses/${emailAddressId}`, { body: params });
    },
    deleteEmailAddress(emailAddressId: string) {
      return http.delete<DeletedObject>(`/v1/email_addresses/${emailAddressId}`);
    },
  };
}

/**
 * Backend phone-number helpers. Reads work; every write answers `403 not_allowed_access` (attaching a verified number
 * or making it the second factor would install a factor the operator holds). The user manages them from their own
 * session (`/v1/client/me/phone_numbers`).
 */
export function createPhoneNumbersApi(http: BackendHttp) {
  return {
    createPhoneNumber(params: { userId: string; phoneNumber: string; verified?: boolean; primary?: boolean; reservedForSecondFactor?: boolean }) {
      return http.post<PhoneNumber>("/v1/phone_numbers", { body: params });
    },
    getPhoneNumber(phoneNumberId: string) {
      return http.get<PhoneNumber>(`/v1/phone_numbers/${phoneNumberId}`);
    },
    updatePhoneNumber(phoneNumberId: string, params: { verified?: boolean; primary?: boolean; reservedForSecondFactor?: boolean }) {
      return http.patch<PhoneNumber>(`/v1/phone_numbers/${phoneNumberId}`, { body: params });
    },
    deletePhoneNumber(phoneNumberId: string) {
      return http.delete<DeletedObject>(`/v1/phone_numbers/${phoneNumberId}`);
    },
  };
}

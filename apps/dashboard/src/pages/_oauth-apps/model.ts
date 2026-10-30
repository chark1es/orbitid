
export interface AppForm {
  id?: string;
  name: string;
  redirectUris: string[];
  scopes: string;
  publicClient: boolean;
  pkceRequired: boolean;
  consentScreenEnabled: boolean;
}

export const EMPTY_FORM: AppForm = {
  name: "",
  redirectUris: [""],
  scopes: "openid profile email",
  publicClient: true,
  pkceRequired: true,
  consentScreenEnabled: true,
};

export function numberFrom(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

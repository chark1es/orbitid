import type * as React from "react";
import type { SignInStatus, SignUpStatus } from "@orbitid/shared";

import type { Appearance } from "../../../appearance";

/** Component-level appearance overrides, merged on top of the provider appearance. */
export type AuthAppearance = Appearance;

export type AuthRouting = "path" | "hash" | "virtual";

export interface SignInInitialValues {
  identifier?: string;
  emailAddress?: string;
  phoneNumber?: string;
  username?: string;
}

export interface SignInProps {
  /** How the internal steps are reflected in the URL. Defaults to `"path"`. */
  routing?: AuthRouting;
  /** Base path of the sign-in route, e.g. `/sign-in`. */
  path?: string;
  /** Target of the "Sign up" footer link. */
  signUpUrl?: string;
  /** Redirect destination after a successful sign-in, taking precedence over `fallbackRedirectUrl`. */
  forceRedirectUrl?: string;
  /** Redirect destination after sign-in when no origin URL is available. */
  fallbackRedirectUrl?: string;
  initialValues?: SignInInitialValues;
  /** Render the footer "Don't have an account?" block. Defaults to `true`. */
  withSignUp?: boolean;
  appearance?: AuthAppearance;
}

export interface SignUpInitialValues {
  emailAddress?: string;
  phoneNumber?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  password?: string;
}

export interface SignUpProps {
  routing?: AuthRouting;
  path?: string;
  signInUrl?: string;
  forceRedirectUrl?: string;
  fallbackRedirectUrl?: string;
  initialValues?: SignUpInitialValues;
  unsafeMetadata?: Record<string, unknown>;
  appearance?: AuthAppearance;
}

export interface UserButtonProps {
  showName?: boolean;
  afterSignOutUrl?: string;
  afterSwitchSessionUrl?: string;
  /** `"modal"` opens `<UserProfile>` in a dialog (default); `"navigation"` navigates to `userProfileUrl`. */
  userProfileMode?: "modal" | "navigation";
  userProfileUrl?: string;
  userProfileProps?: UserProfileProps;
  appearance?: AuthAppearance;
  children?: React.ReactNode;
}

/** Built-in `<UserProfile>` pages, in their default order. Organizations, Apps, Billing and API keys only show when they apply. */
export const USER_PROFILE_PAGES = ["profile", "security", "organizations", "apps", "billing", "api-keys"] as const;
export type UserProfilePageId = (typeof USER_PROFILE_PAGES)[number] | (string & {});

export interface UserProfileProps {
  routing?: AuthRouting;
  path?: string;
  appearance?: AuthAppearance;
  /** Page shown initially. Defaults to the first available page. */
  defaultPage?: UserProfilePageId;
  /**
   * `<UserProfile.Page>` / `<UserProfile.Link>` elements: custom pages and links, and references to built-in
   * pages that reorder, hide or fill them (`<UserProfile.Page label="billing">…</UserProfile.Page>`).
   */
  children?: React.ReactNode;
  /** Wrapper rendered by `<UserButton>` in modal mode. */
  __modal?: boolean;
}

export interface WaitlistProps {
  afterJoinWaitlistUrl?: string;
  signInUrl?: string;
  appearance?: AuthAppearance;
}

export interface OAuthConsentProps {
  /** Fallback for the `client_id` query parameter. */
  clientId?: string;
  scope?: string;
  redirectUri?: string;
  state?: string;
  /** API origin; defaults to the OrbitID instance's frontend API URL. */
  frontendApiUrl?: string;
  appearance?: AuthAppearance;
  onAllow?: (redirectUrl: string | null) => void;
  onDeny?: (redirectUrl: string | null) => void;
}

export interface VerificationModalProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onVerified?: () => void;
  onCancel?: () => void;
  title?: string;
  subtitle?: string;
  appearance?: AuthAppearance;
}

export interface SignInResource {
  id: string;
  status: SignInStatus;
  identifier: string | null;
  supported_identifiers?: string[] | null;
  supported_first_factors?: Array<{
    strategy: string;
    email_address_id?: string;
    phone_number_id?: string;
    safe_identifier?: string;
    primary?: boolean;
    default?: boolean;
  }> | null;
  supported_second_factors?: Array<{
    strategy: string;
    email_address_id?: string;
    phone_number_id?: string;
    safe_identifier?: string;
    primary?: boolean;
    default?: boolean;
  }> | null;
  first_factor_verification?: VerificationLike | null;
  second_factor_verification?: VerificationLike | null;
  user_data?: {
    first_name: string | null;
    last_name: string | null;
    image_url: string;
    has_image: boolean;
  } | null;
  created_session_id: string | null;
}

export interface SignInFactorView {
  strategy: string;
  email_address_id?: string;
  phone_number_id?: string;
  safe_identifier?: string;
  primary?: boolean;
  default?: boolean;
}

export interface VerificationLike {
  status: "unverified" | "verified" | "transferable" | "failed" | "expired";
  strategy: string;
  attempts?: number | null;
  expire_at?: number | null;
  external_verification_redirect_url?: string | null;
  error?: { code: string; message: string } | null;
  nonce?: string | null;
}

export interface SignUpResource {
  id: string;
  status: SignUpStatus;
  required_fields?: string[];
  optional_fields?: string[];
  missing_fields?: string[];
  unverified_fields?: string[];
  verifications?: {
    email_address?: VerificationLike | null;
    phone_number?: VerificationLike | null;
    external_account?: VerificationLike | null;
    web3_wallet?: VerificationLike | null;
  };
  username: string | null;
  email_address: string | null;
  phone_number: string | null;
  first_name: string | null;
  last_name: string | null;
  password_enabled?: boolean;
  created_session_id: string | null;
  created_user_id?: string | null;
}

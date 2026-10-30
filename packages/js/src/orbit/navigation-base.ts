import {
  buildAfterSignInUrl,
  buildAfterSignOutUrl,
  buildAfterSignUpUrl,
  buildCreateOrganizationUrl,
  buildOrganizationProfileUrl,
  buildSignInUrl,
  buildSignUpUrl,
  buildUserProfileUrl,
  buildWaitlistUrl,
  navigate as navigateTo,
} from "./navigation";
import type { OrbitIDOptions } from "./types";

/**
 * URL building, redirects and navigation. Kept on a base class so the large state/lifecycle half of `OrbitID`
 * stays readable while every public method keeps its original call shape.
 */
export abstract class OrbitIDNavigation {
  protected abstract readonly options: OrbitIDOptions;

  navigate(to: string, options: { replace?: boolean } = {}): void {
    navigateTo(this.options, to, options);
  }

  buildSignInUrl(params: { redirectUrl?: string } = {}): string {
    return buildSignInUrl(this.options, params);
  }
  buildSignUpUrl(params: { redirectUrl?: string } = {}): string {
    return buildSignUpUrl(this.options, params);
  }
  buildUserProfileUrl(params: { redirectUrl?: string } = {}): string {
    return buildUserProfileUrl(this.options, params);
  }
  buildCreateOrganizationUrl(): string {
    return buildCreateOrganizationUrl(this.options);
  }
  buildOrganizationProfileUrl(params: { organizationId?: string } = {}): string {
    return buildOrganizationProfileUrl(this.options, params);
  }
  buildWaitlistUrl(): string {
    return buildWaitlistUrl(this.options);
  }
  buildAfterSignInUrl(): string {
    return buildAfterSignInUrl(this.options);
  }
  buildAfterSignUpUrl(): string {
    return buildAfterSignUpUrl(this.options);
  }
  buildAfterSignOutUrl(): string {
    return buildAfterSignOutUrl(this.options);
  }

  redirectToSignIn(params: { redirectUrl?: string } = {}): void {
    this.navigate(this.buildSignInUrl(params));
  }
  redirectToSignUp(params: { redirectUrl?: string } = {}): void {
    this.navigate(this.buildSignUpUrl(params));
  }
  redirectToUserProfile(params: { redirectUrl?: string } = {}): void {
    this.navigate(this.buildUserProfileUrl(params));
  }
  redirectToCreateOrganization(): void {
    this.navigate(this.buildCreateOrganizationUrl());
  }
  redirectToOrganizationProfile(params: { organizationId?: string } = {}): void {
    this.navigate(this.buildOrganizationProfileUrl(params));
  }
  redirectToAfterSignIn(): void {
    this.navigate(this.buildAfterSignInUrl(), { replace: true });
  }
  redirectToAfterSignUp(): void {
    this.navigate(this.buildAfterSignUpUrl(), { replace: true });
  }
  redirectToAfterSignOut(): void {
    this.navigate(this.buildAfterSignOutUrl(), { replace: true });
  }
}

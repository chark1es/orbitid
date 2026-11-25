import type { ReactNode } from "react";
import type { Appearance } from "../../../appearance";
import type { ProfileLinkProps, ProfilePageProps } from "../../../lib/profile-pages";

export type { Appearance };

/** Props every org component shares. */
export interface CommonOrgProps {
  /** Appearance overrides merged on top of the provider's appearance. */
  appearance?: Appearance;
  className?: string;
}

/** `string`, or a function producing the URL from the resource. */
export type RedirectUrl<T> = string | ((resource: T) => string);

export interface RoleOption {
  key: string;
  name: string;
}

/** `<OrganizationProfile.Page>`: a custom page, or a reference to a built-in page (see `ProfilePageProps`). */
export type OrgProfileCustomPageProps = ProfilePageProps;

/** `<OrganizationProfile.Link>`: an external entry in the navigation. */
export type OrgProfileCustomLinkProps = ProfileLinkProps;

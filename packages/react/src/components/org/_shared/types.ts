import type { ReactNode } from "react";
import type { Appearance } from "../../../appearance";

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

export interface OrgProfileCustomPageProps {
  /** Navigation label. */
  label: string;
  /** Section slug used in the URL (`#/team`). */
  url: string;
  /** Optional icon shown next to the label. */
  labelIcon?: ReactNode;
  children?: ReactNode;
}

export interface OrgProfileCustomLinkProps {
  label: string;
  /** Absolute or relative href rendered in the navbar. */
  url: string;
  labelIcon?: ReactNode;
}

import type { ApiErrorItem, Metadata, ReverificationConfig, SessionClaims } from "@orbitid/shared";

export type { ApiErrorItem, Metadata, ReverificationConfig, SessionClaims };

export interface Actor {
  sub: string;
  sid?: string;
  [key: string]: unknown;
}

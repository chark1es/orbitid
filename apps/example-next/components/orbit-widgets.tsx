"use client";

// Single client boundary for the prebuilt OrbitID widgets so App Router pages stay server components.
export {
  SignIn,
  SignUp,
  Waitlist,
  UserProfile,
  OrganizationProfile,
  CreateOrganization,
  OAuthConsent,
} from "@orbitid/react";

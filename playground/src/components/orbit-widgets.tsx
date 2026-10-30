"use client";

// One client boundary for the prebuilt widgets so App Router pages stay server components.
export {
  APIKeys,
  CreateOrganization,
  OrganizationList,
  OrganizationProfile,
  OrganizationSwitcher,
  SignIn,
  SignUp,
  UserProfile,
  Waitlist,
  useOrganizationsEnabled,
} from "@orbitid/react";

// Barrel. Each sub-folder owns its own index.ts (owners: see docs/ARCHITECTURE.md → worker table).
export * from "./provider";   // W6: OrbitIDProvider, context, appearance/localization types
export * from "./hooks";      // W6: useAuth, useUser, useSignIn, ...
export * from "./control";    // W6: SignedIn, SignedOut, Protect, Redirect*
export * from "./components/auth"; // W7: SignIn, SignUp, UserButton, UserProfile, Waitlist
export * from "./components/org";  // W8: OrganizationSwitcher, OrganizationProfile, OrganizationList, CreateOrganization, APIKeys
export * from "./appearance";      // W6: appearance types, themes, useAppearance/useElementClasses
export * from "./localization";    // W6: LocalizationResource, enUS/de/fr/es, useLocalizations
export * from "./lib";             // W6: router, redirects, error mapping, submit helpers

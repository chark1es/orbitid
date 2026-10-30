export { AuthUIError, toAuthError, errorMessage, isReverificationError, invokeMethod } from "./errors";
export { currentClient, currentSession, pickSignIn, pickSignUp, pickSessionId } from "./client";
export { signInCreate, signInPrepareFirstFactor, signInAttemptFirstFactor, signInPrepareSecondFactor, signInAttemptSecondFactor, signInResetPassword, signInAuthenticateWithRedirect, signInAuthenticateWithPasskey, signInReload } from "./sign-in";
export type { SignInResult } from "./sign-in";
export { signUpCreate, signUpUpdate, signUpPrepareVerification, signUpAttemptVerification, signUpAuthenticateWithRedirect } from "./sign-up";
export { findSession, activateSession, finishAuth, signOut, currentUser, findEmail, findPhone, findExternalAccount, prepareEmailVerification, attemptEmailVerification, preparePhoneVerification, attemptPhoneVerification, refreshClient, reloadOrbit } from "./session";
export { primaryIdentifier, displayName, initials, factorsOf, verificationStatus, isTransferable, apiOrigin, apiRequest } from "./identity";

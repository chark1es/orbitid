/** frontend paths: auth. */
import { ref } from "../../schema";
import { op, type DocumentedOperation } from "../../operation";
import * as body from "../../requests";
import { fapiWithClient } from "../common";
import { id, tagSignIn, tagSignUp } from "./common";

export const operations: DocumentedOperation[] = [
  // ───────────── environment ─────────────
  op("get", "/v1/client/environment", "Instance", "getEnvironment", "Read the environment settings", {
    security: "none",
    description:
      "Public projection of the instance settings that every UI component renders from: enabled factors, attribute " +
      "requirements, organization settings and branding. Cacheable for 60 seconds; contains no secrets.",
    success: { status: 200, schema: ref("Environment") },
    errors: [429],
  }),

  // ───────────── sign in ─────────────
  op("post", "/v1/client/sign_ins", tagSignIn, "createSignIn", "Start a sign-in", {
    security: "frontendOptional",
    description:
      "Creates a sign-in attempt for this client and advances it as far as the request allows. `status` says what is " +
      "needed next: `needs_identifier`, `needs_first_factor`, `needs_second_factor`, `needs_new_password` or " +
      "`complete` (with `created_session_id`). Starting an OAuth or enterprise SSO strategy returns " +
      "`first_factor_verification.external_verification_redirect_url`; navigate the browser there. " +
      "Failed password attempts count towards the user's lockout, and unknown identifiers return " +
      "`form_identifier_not_found` unless enumeration protection is on. Rate limited per IP and identifier.",
    body: { schema: body.signInCreate },
    ...fapiWithClient(ref("SignIn")),
    errors: [400, 403, 404, 422, 429],
  }),
  op("get", "/v1/client/sign_ins/{id}", tagSignIn, "getSignIn", "Read a sign-in attempt", {
    security: "frontendOptional",
    description: "Lets a second tab or a polling page observe progress (for example after an email link was opened elsewhere).",
    parameters: [id],
    ...fapiWithClient(ref("SignIn")),
    errors: [403, 404],
  }),
  op("post", "/v1/client/sign_ins/{id}/prepare_first_factor", tagSignIn, "prepareSignInFirstFactor", "Send a first-factor challenge", {
    security: "frontendOptional",
    description:
      "Sends the email code, magic link or SMS code for the chosen strategy, or arms an OAuth redirect. The response " +
      "carries the updated sign-in, so read `first_factor_verification` for the strategy state.",
    parameters: [id],
    body: { schema: body.signInPrepareFirst },
    ...fapiWithClient(ref("SignIn")),
    errors: [400, 403, 404, 409, 422, 429],
  }),
  op("post", "/v1/client/sign_ins/{id}/attempt_first_factor", tagSignIn, "attemptSignInFirstFactor", "Submit a first factor", {
    security: "frontendOptional",
    description:
      "Verifies the password, code, passkey assertion or OAuth callback. Wrong codes and passwords return " +
      "`form_code_incorrect` / `form_password_incorrect` and count towards the lockout. Rate limited.",
    parameters: [id],
    body: { schema: body.signInAttemptFirst },
    ...fapiWithClient(ref("SignIn")),
    errors: [400, 403, 404, 422, 429],
  }),
  op("post", "/v1/client/sign_ins/{id}/prepare_second_factor", tagSignIn, "prepareSignInSecondFactor", "Send a second-factor challenge", {
    security: "frontendOptional",
    description: "Sends an SMS code when the strategy is `phone_code`; `totp` and `backup_code` need no preparation.",
    parameters: [id],
    body: { schema: body.signInPrepareSecond },
    ...fapiWithClient(ref("SignIn")),
    errors: [400, 403, 404, 422, 429],
  }),
  op("post", "/v1/client/sign_ins/{id}/attempt_second_factor", tagSignIn, "attemptSignInSecondFactor", "Submit a second factor", {
    security: "frontendOptional",
    description: "Verifies a TOTP code, SMS code or single-use backup code. A completed sign-in returns `created_session_id`.",
    parameters: [id],
    body: { schema: body.signInAttemptSecond },
    ...fapiWithClient(ref("SignIn")),
    errors: [400, 403, 404, 422, 429],
  }),
  op("post", "/v1/client/sign_ins/{id}/reset_password", tagSignIn, "resetSignInPassword", "Set a new password during sign-in", {
    security: "frontendOptional",
    description:
      "Completes the `needs_new_password` state, which is entered after a password-reset code was verified. The password " +
      "policy is enforced. `sign_out_of_other_sessions` ends the user's other active sessions.",
    parameters: [id],
    body: { schema: body.signInResetPassword },
    ...fapiWithClient(ref("SignIn")),
    errors: [400, 403, 404, 422, 429],
  }),

  // ───────────── sign up ─────────────
  op("post", "/v1/client/sign_ups", tagSignUp, "createSignUp", "Start a sign-up", {
    security: "frontendOptional",
    description:
      "Creates an account attempt. The response's `missing_fields` and `unverified_fields` are computed from the " +
      "instance's attribute settings; fill them in with `PATCH` and verify identifiers with " +
      "`prepare_verification`/`attempt_verification`. Sign-up completes (`status: complete`, `created_session_id` set) " +
      "as soon as nothing is missing. Sign-up is gated by the instance's sign-up mode, the allow/block lists and " +
      "invitation tickets. Rate limited per IP.",
    body: { schema: body.signUpCreate },
    ...fapiWithClient(ref("SignUp")),
    errors: [400, 403, 409, 422, 429],
  }),
  op("get", "/v1/client/sign_ups/{id}", tagSignUp, "getSignUp", "Read a sign-up attempt", {
    security: "frontendOptional",
    description: "Poll this after a magic link was opened in another tab.",
    parameters: [id],
    ...fapiWithClient(ref("SignUp")),
    errors: [403, 404],
  }),
  op("patch", "/v1/client/sign_ups/{id}", tagSignUp, "updateSignUp", "Add fields to a sign-up", {
    security: "frontendOptional",
    description: "Only a sign-up in `missing_requirements` can be updated. Changing an identifier invalidates its outstanding verification.",
    parameters: [id],
    body: { schema: body.signUpUpdate },
    ...fapiWithClient(ref("SignUp")),
    errors: [400, 403, 404, 409, 422, 429],
  }),
  op("post", "/v1/client/sign_ups/{id}/prepare_verification", tagSignUp, "prepareSignUpVerification", "Send an identifier verification", {
    security: "frontendOptional",
    description: "Sends a code or magic link for `email_address` or `phone_number` (`strategy`: `email_code`, `email_link`, `phone_code`).",
    parameters: [id],
    body: { schema: body.verificationPrepare },
    ...fapiWithClient(ref("SignUp")),
    errors: [400, 403, 404, 422, 429],
  }),
  op("post", "/v1/client/sign_ups/{id}/attempt_verification", tagSignUp, "attemptSignUpVerification", "Submit an identifier verification", {
    security: "frontendOptional",
    description: "Verifies the code. When nothing else is missing or unverified the sign-up completes and a session is created.",
    parameters: [id],
    body: { schema: body.verificationAttempt },
    ...fapiWithClient(ref("SignUp")),
    errors: [400, 403, 404, 422, 429],
  }),
];

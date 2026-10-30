import type { LocalizationResource } from "../types";

export const componentAuthStrings = {
  signIn: {
    start: {
      identifierLabel: "Email address, phone number, or username",
      identifierPlaceholder: "Enter your email, phone, or username",
      useAnotherMethod: "Use another method",
      forgotPassword: "Forgot password?",
      noAccount: "Don't have an account?",
      signUpAction: "Sign up",
    },
    password: {
      action: "Continue",
      forgotPassword: "Forgot password?",
      useAnotherMethod: "Use another method",
    },
    emailCode: {
      action: "Verify",
      resend: "Resend code",
      resendIn: "Resend code in {{seconds}}s",
    },
    emailLink: {
      iAlreadyClicked: "I've already clicked the link",
      resend: "Resend link",
      waiting: "Waiting for verification…",
    },
    phoneCode: {
      action: "Verify",
      resend: "Resend code",
    },
    forgotPassword: {
      action: "Send reset code",
      back: "Back to sign in",
    },
    resetPassword: {
      action: "Reset password",
      signOutOtherDevices: "Sign out of all other devices",
    },
    newPassword: {
      action: "Continue",
    },
    chooseStrategy: {
      title: "Use another method",
      subtitle: "Select a method to sign in to your account.",
      password: "Password",
      emailCode: "Email code",
      emailLink: "Email link",
      phoneCode: "Phone code",
      passkey: "Passkey",
      enterpriseSso: "Enterprise SSO",
      resetPassword: "Reset password",
      oauth: "Continue with {{provider}}",
    },
    secondFactor: {
      title: "Verify your identity",
      subtitle: "We need to verify your identity before you can continue.",
      totp: "Enter the code from your authenticator app.",
      phoneCode: "Enter the code we sent to your phone.",
      emailCode: "Enter the code we sent to your email address.",
      backupCode: "Enter one of your backup codes.",
      action: "Verify",
      useAnotherMethod: "Use another method",
      /** Checkbox label; `{{days}}` is `settings.session.trustedDeviceDays`. */
      trustDevice: "Trust this browser for {{days}} days",
      methodTotp: "Authenticator app",
      methodPhoneCode: "Text message code",
      methodEmailCode: "Email code",
      methodBackupCode: "Backup code",
    },
    enterpriseSso: {
      title: "Enterprise SSO",
      subtitle: "Sign in with your organization's identity provider.",
      action: "Continue with SSO",
    },
    transfer: {
      title: "Account exists",
      message: "An account already exists for {{identifier}}. Continue to sign up to transfer it?",
      action: "Continue to sign up",
    },
    success: {
      title: "You're signed in",
      message: "You can continue to {{applicationName}}.",
      action: "Continue",
    },
    ssoCallback: {
      processing: "Completing sign in…",
      error: "We couldn't complete the sign in. Please try again.",
    },
    passkey: {
      button: "Sign in with a passkey",
    },
    setupTwoFactor: {
      title: "Set up two-factor authentication",
      subtitle: "This account needs a second factor. Add one now to finish signing in.",
      scanQr: "Scan this QR code with your authenticator app, or enter the secret key.",
      secret: "Secret key",
      copySecret: "Copy secret key",
      codeLabel: "Enter the 6-digit code from your authenticator app",
      verify: "Verify and continue",
      usePhone: "Use a phone number instead",
      useAuthenticator: "Use an authenticator app instead",
      phoneLabel: "Phone number",
      sendCode: "Send code",
      phoneCodeLabel: "Enter the code we sent to your phone",
      phoneVerify: "Verify phone number",
      backupTitle: "Save your backup codes",
      backupDescription: "Each code signs you in once. Store them somewhere safe. They will not be shown again.",
      backupCopy: "Copy codes",
      backupDownload: "Download codes",
      backupFilename: "orbitid-backup-codes.txt",
      continue: "Continue",
    },
    lastUsed: "Last used",
    oauth: {
      error: "Could not start the social sign in. Please try again.",
    },
  },
  signUp: {
    start: {
      action: "Create account",
      haveAccount: "Already have an account?",
      signInAction: "Sign in",
      legalConsent: "I agree to the {{terms}} and {{privacy}}.",
      legalConsentPlain: "I agree to the terms of service and privacy policy.",
      legalConsentPrefix: "I agree to the",
      legalConsentConjunction: "and",
      passwordHint: "Password must:",
      passwordHintLength: "Be at least {{min}} characters",
      passwordHintLowercase: "Include a lowercase letter",
      passwordHintUppercase: "Include an uppercase letter",
      passwordHintNumbers: "Include a number",
      passwordHintSpecial: "Include a special character",
    },
    verifyEmailCode: {
      title: "Verify your email",
      subtitle: "We sent a code to {{identifier}}.",
      action: "Verify email",
    },
    verifyEmailLink: {
      title: "Verify your email",
      subtitle: "We sent a verification link to {{identifier}}. Click the link to continue.",
      iAlreadyClicked: "I've already clicked the link",
    },
    verifyPhoneCode: {
      title: "Verify your phone",
      subtitle: "We sent a code to {{identifier}}.",
      action: "Verify phone",
    },
    continue: {
      action: "Continue",
    },
    restricted: {
      message: "Sign up for {{applicationName}} is by invitation only. Please sign in or contact the administrator.",
    },
    waitlist: {
      backToSignIn: "Back to sign in",
    },
    success: {
      title: "Welcome to {{applicationName}}",
      message: "Your account is ready.",
      action: "Continue",
    },
    ticket: {
      label: "Invitation code",
    },
    oauth: {
      error: "Could not start the social sign up. Please try again.",
    },
    passwordStrength: {
      weak: "Weak",
      fair: "Fair",
      good: "Good",
      strong: "Strong",
    },
  },
} satisfies LocalizationResource;

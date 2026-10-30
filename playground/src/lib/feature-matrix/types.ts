export type FeatureStatus = "enabled" | "off" | "needs-config";

export interface FeatureRow {
  id: string;
  label: string;
  status: FeatureStatus;
  value: string;
  detail?: string;
  tryHref: string;
  /** OAuth strategy, present on social provider rows so the row can start a real sign-in. */
  strategy?: string;
}

export interface FeatureSection {
  id: string;
  title: string;
  hint?: string;
  rows: FeatureRow[];
}

/** The parts of `PATCH /v1/instance` settings that the public environment does not expose. */
export interface InstanceSnapshot {
  session?: {
    lifetimeSeconds?: number;
    tokenLifetimeSeconds?: number;
    multiSession?: boolean;
    trustedDevicesEnabled?: boolean;
    trustedDeviceDays?: number;
  };
  mfa?: { required?: boolean };
  anonymous?: { enabled?: boolean; retentionSeconds?: number };
  /** Masked email settings: only the `<field>Set` markers are read, never a value. */
  email?: {
    provider?: string;
    resendApiKeySet?: boolean;
    smtpUrlSet?: boolean;
  };
  oidcProvider?: {
    accessTokenFormat?: string;
    deviceAuthorizationEnabled?: boolean;
    deviceCodeLifetimeSeconds?: number;
    deviceCodeIntervalSeconds?: number;
  };
  attributes?: {
    emailAddress?: { usedForSecondFactor?: boolean };
  };
}

export const STATUS_LABEL: Record<FeatureStatus, string> = {
  enabled: "Enabled",
  off: "Off",
  "needs-config": "Needs config",
};

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export const EMAIL_DELIVERY_QUERY_KEY = ["instance", "email-delivery"];

/** The transport the server resolves, environment variables included. `console` means mail is not sent. */
export type EmailDeliveryProvider = "resend" | "smtp" | "console";

export interface EmailDelivery {
  /** Null when the server is too old to report it; callers then stay quiet rather than guess. */
  provider: EmailDeliveryProvider | null;
}

export function parseEmailDelivery(response: unknown): EmailDelivery {
  const record = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  const delivery = record.email_delivery;
  const provider =
    delivery && typeof delivery === "object" ? (delivery as Record<string, unknown>).provider : undefined;
  return {
    provider: provider === "resend" || provider === "smtp" || provider === "console" ? provider : null,
  };
}

/**
 * Whether mail actually leaves this server. Read from `GET /instance`'s `email_delivery`, which the
 * server resolves itself: the dashboard cannot see ORBITID_RESEND_API_KEY / ORBITID_SMTP_URL, so
 * deciding from the stored settings alone would nag operators who configured email by environment.
 */
export function useEmailDelivery() {
  return useQuery<EmailDelivery>({
    queryKey: EMAIL_DELIVERY_QUERY_KEY,
    queryFn: async ({ signal }) => parseEmailDelivery(await api<unknown>("GET", "/instance", undefined, signal)),
    staleTime: 60_000,
  });
}

/** True only when the server says mail is not delivered. */
export function useEmailNotConfigured(): boolean {
  const { data } = useEmailDelivery();
  return data?.provider === "console";
}

export const EMAIL_SETTINGS_HREF = "/settings/email-sms";

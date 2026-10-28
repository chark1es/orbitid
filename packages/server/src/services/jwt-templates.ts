// OWNER: worker "admin" (W3).
import type { AppContext } from "../context";

/**
 * Resolve a named JWT template into claims + options. Shortcodes: {{user.id}}, {{user.first_name}}, {{user.last_name}}, {{user.full_name}},
 * {{user.primary_email_address}}, {{user.primary_phone_number}}, {{user.username}}, {{user.public_metadata}}, {{user.public_metadata.foo.bar}}, {{user.unsafe_metadata}},
 * {{user.email_verified}}, {{user.phone_number_verified}}, {{user.image_url}}, {{user.created_at}}, {{org.id}}, {{org.slug}}, {{org.name}}, {{org.role}}, {{org.public_metadata}},
 * {{session.id}}, {{session.actor}}, {{org_membership.permissions}}. A claim whose whole value is one shortcode keeps its JSON type; "||" gives fallbacks; strings may interpolate.
 * Returns null if template does not exist.
 */
export async function renderTemplateClaims(_ctx: AppContext, _templateName: string, _input: { userId: string; sessionId?: string; orgId?: string | null }):
  Promise<null | { claims: Record<string, unknown>; lifetimeSeconds: number; allowedClockSkewSeconds: number; signingKeyEnc?: string | null; algorithm: string }> {
  throw new Error("not implemented (W3)");
}

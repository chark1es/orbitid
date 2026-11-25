-- Operator-configured external billing portals.
--
-- OrbitID does not process payments. An operator can point an organization and
-- an OAuth application at an external billing portal (Stripe's customer portal,
-- Paddle, a page of their own); the prebuilt account components link to it.
-- NULL (every existing row) means no portal is configured. The Backend API only
-- stores absolute https URLs (see docs/BILLING.md).
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "billing_portal_url" text;
ALTER TABLE "oauth_applications" ADD COLUMN IF NOT EXISTS "billing_portal_url" text;

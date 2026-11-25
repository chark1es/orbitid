-- Organization-owned OAuth applications and per-user cross-organization access.
--
-- `oauth_applications.organization_id` is the owning organization. NULL (every
-- application that existed before this migration) means instance-wide: any
-- user who can sign in may use it, exactly as before. When it is set, only the
-- organization's members, plus users an operator granted access to that
-- specific application (`oauth_application_access_grants`), may obtain grants
-- or tokens for it.
--
-- The foreign key is ON DELETE RESTRICT on purpose: deleting the owner must not
-- silently widen an application to the whole instance (SET NULL) or delete an
-- operator-configured client (CASCADE). Organization deletion refuses while the
-- organization owns applications; operators reassign or delete them first.
--
-- No IF NOT EXISTS guards: a partially applied run must fail loudly, not skip.
ALTER TABLE "oauth_applications" ADD COLUMN "organization_id" text;

ALTER TABLE "oauth_applications"
    ADD CONSTRAINT "oauth_applications_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;

-- `oauth_applications` is a small table; a plain (transactional) build is a
-- short lock.
CREATE INDEX "oauth_applications_organization_idx"
    ON "oauth_applications" ("organization_id")
    WHERE "organization_id" IS NOT NULL;

-- Explicit access to one organization-owned application for a user who is not
-- (or no longer) a member of the owning organization. Operators manage these
-- rows through the Backend API only, and only while the application has an
-- owner (clearing the owner deletes them).
CREATE TABLE "oauth_application_access_grants" (
    "application_id" text NOT NULL
        REFERENCES "public"."oauth_applications"("id") ON DELETE CASCADE,
    "user_id" text NOT NULL
        REFERENCES "public"."users"("id") ON DELETE CASCADE,
    "created_at" bigint NOT NULL,
    CONSTRAINT "oauth_application_access_grants_pk" PRIMARY KEY ("application_id", "user_id")
);

CREATE INDEX "oauth_application_access_grants_user_idx"
    ON "oauth_application_access_grants" ("user_id");

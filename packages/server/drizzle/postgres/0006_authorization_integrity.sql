DELETE FROM "user_roles" WHERE "role_key" NOT IN (SELECT "key" FROM "roles");
--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_key_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."roles"("key") ON DELETE cascade ON UPDATE no action;

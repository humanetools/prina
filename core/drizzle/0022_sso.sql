CREATE TABLE "sso_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" text,
	"email_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_workspace_id" uuid,
	"default_role_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_connections_default_workspace_id_workspaces_id_fk" FOREIGN KEY ("default_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "sso_connections_default_role_id_roles_id_fk" FOREIGN KEY ("default_role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"subject" text,
	"email" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "user_identities_connection_id_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sso_connections"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "sso_login_states" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sso_login_states_connection_id_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sso_connections"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "scim_tokens_connection_id_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sso_connections"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "scim_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "scim_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text,
	"workspace_id" uuid,
	"role_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_groups_connection_id_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sso_connections"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "scim_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "scim_groups_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "scim_group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "scim_group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id"),
	CONSTRAINT "scim_group_members_group_id_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_groups"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "scim_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_conn_subject_uq" ON "user_identities" USING btree ("connection_id","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_conn_user_uq" ON "user_identities" USING btree ("connection_id","user_id");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sso_login_states_expires_idx" ON "sso_login_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_groups_conn_name_uq" ON "scim_groups" USING btree ("connection_id","display_name");--> statement-breakpoint
CREATE INDEX "scim_group_members_user_idx" ON "scim_group_members" USING btree ("user_id");

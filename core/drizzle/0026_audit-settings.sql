CREATE TABLE "audit_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"retention_days" integer,
	"stream_url" text,
	"stream_token" text,
	"stream_enabled" boolean DEFAULT false NOT NULL,
	"stream_last_id" bigint DEFAULT 0 NOT NULL,
	"stream_last_sent_at" timestamp with time zone,
	"stream_last_error" text,
	"stream_failures" integer DEFAULT 0 NOT NULL,
	"stream_next_try_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
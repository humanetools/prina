CREATE TABLE "content_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"action" text NOT NULL,
	"run_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" text,
	"created_by_label" text,
	"run_by" text,
	"run_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	"result" jsonb,
	CONSTRAINT "content_releases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "content_release_items" (
	"release_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"type_uid" text NOT NULL,
	"added_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_release_items_release_id_entry_id_pk" PRIMARY KEY("release_id","entry_id"),
	CONSTRAINT "content_release_items_release_id_content_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."content_releases"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "content_release_items_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE "entry_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"type_uid" text NOT NULL,
	"action" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"scheduled_by" text,
	"scheduled_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "entry_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "entry_schedules_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "content_release_items_entry_idx" ON "content_release_items" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "content_releases_due_idx" ON "content_releases" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "content_releases_ws_idx" ON "content_releases" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "entry_schedules_due_idx" ON "entry_schedules" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "entry_schedules_entry_idx" ON "entry_schedules" USING btree ("entry_id");

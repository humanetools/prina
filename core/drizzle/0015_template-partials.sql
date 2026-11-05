CREATE TABLE "template_partials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"liquid" text DEFAULT '' NOT NULL,
	"liquid_edit" text DEFAULT '' NOT NULL,
	"js" text DEFAULT '' NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_partials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "template_partials_ws_name_ver_uq" ON "template_partials" USING btree ("workspace_id","name","version");--> statement-breakpoint
CREATE INDEX "template_partials_ws_current_idx" ON "template_partials" USING btree ("workspace_id","is_current");
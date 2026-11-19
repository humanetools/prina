CREATE TABLE "asset_rights_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"proposed" jsonb NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"requested_by_label" text,
	"decided_by" text,
	"decided_by_label" text,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "asset_rights_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "asset_rights_requests_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "rights" jsonb;--> statement-breakpoint
CREATE INDEX "asset_rights_requests_ws_status_idx" ON "asset_rights_requests" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "asset_rights_requests_asset_idx" ON "asset_rights_requests" USING btree ("asset_id");

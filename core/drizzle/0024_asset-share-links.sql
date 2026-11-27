CREATE TABLE "asset_share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token" text NOT NULL,
	"name" text NOT NULL,
	"asset_ids" jsonb NOT NULL,
	"mode" text NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone,
	CONSTRAINT "asset_share_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "asset_share_links_token_uq" ON "asset_share_links" USING btree ("token");--> statement-breakpoint
CREATE INDEX "asset_share_links_ws_idx" ON "asset_share_links" USING btree ("workspace_id","created_at");
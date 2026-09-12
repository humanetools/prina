CREATE TABLE "mcp_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plane" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"role_id" uuid,
	"locale_scope" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_tokens_ws_idx" ON "mcp_tokens" USING btree ("workspace_id","plane");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_tokens_ws_name_uq" ON "mcp_tokens" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "entries_search_trgm_idx" ON "entries" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "entries_search_fts_idx" ON "entries" USING gin (to_tsvector('simple', coalesce("search_text", '')));

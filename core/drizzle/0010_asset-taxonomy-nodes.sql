CREATE TABLE "asset_taxonomy_nodes" (
	"workspace_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	CONSTRAINT "asset_taxonomy_nodes_asset_id_node_id_pk" PRIMARY KEY("asset_id","node_id"),
	CONSTRAINT "asset_taxonomy_nodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "asset_taxonomy_nodes_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "asset_taxonomy_nodes_node_id_taxonomy_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."taxonomy_nodes"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "asset_taxonomy_nodes_node_idx" ON "asset_taxonomy_nodes" USING btree ("node_id");

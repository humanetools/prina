CREATE TABLE "component_folders" (
	"workspace_id" uuid NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "component_folders_workspace_id_path_pk" PRIMARY KEY("workspace_id","path"),
	CONSTRAINT "component_folders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "folder" text DEFAULT '/' NOT NULL;
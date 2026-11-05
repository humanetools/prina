CREATE TABLE "content_type_folders" (
	"workspace_id" uuid NOT NULL,
	"kind" "content_type_kind" NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_type_folders_workspace_id_kind_path_pk" PRIMARY KEY("workspace_id","kind","path"),
	CONSTRAINT "content_type_folders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
ALTER TABLE "content_types" ADD COLUMN "folder" text DEFAULT '/' NOT NULL;

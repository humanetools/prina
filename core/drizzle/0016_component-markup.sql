ALTER TABLE "components" ADD COLUMN "options" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "template_partials" ADD COLUMN "css" text DEFAULT '' NOT NULL;
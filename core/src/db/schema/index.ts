/**
 * Core static schema (T1.1) — only this is subject to DDL migrations.
 * Content data itself lives in entries.values (JSONB), so type changes cause no DDL.
 * For ERD annotations, follow the SPEC § references at the top of each file.
 */
export * from "./enums.js";
export * from "./instance.js";
export * from "./identity.js";
export * from "./workflow.js";
export * from "./content.js";
export * from "./taxonomy.js";
export * from "./versioning.js";
export * from "./assets.js";
export * from "./templates.js";
export * from "./mcp.js";

import { pgEnum } from "drizzle-orm/pg-core";
import {
  ENTRY_STATUSES,
  ACTOR_TYPES,
  CONTENT_TYPE_KINDS,
} from "@prina/shared";

/** DB enums derive from the TS enums in @prina/shared — single source keeping both in sync */
export const entryStatusEnum = pgEnum(
  "entry_status",
  ENTRY_STATUSES as [string, ...string[]],
);
export const actorTypeEnum = pgEnum(
  "actor_type",
  ACTOR_TYPES as [string, ...string[]],
);
export const contentTypeKindEnum = pgEnum(
  "content_type_kind",
  CONTENT_TYPE_KINDS as [string, ...string[]],
);

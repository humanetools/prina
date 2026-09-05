/**
 * Type preset catalog (T7.2, §2.9) — install = copy. Freely editable after install (independent of the original).
 * Product ships the full setup: variant axes, attribute-set component, predicates, schema.org.
 * [scope note] "Bundled images" ships once real demo assets (photo licensing) are secured — fields only for now.
 */
import { ContentTypeKind } from "@prina/shared";
import type { ContentTypeDefinition } from "@prina/shared";

export interface PresetBundle {
  id: string;
  name: string;
  description: string;
  contentType: {
    uid: string;
    kind: ContentTypeKind;
    name: string;
    schemaOrgType: string | null;
    definition: ContentTypeDefinition;
  };
  components?: Array<{ uid: string; name: string; definition: ContentTypeDefinition }>;
}

const productDefinition = {
  displayField: "title",
  fields: [
    { name: "title", type: "text", label: "Name", required: true },
    { name: "sku", type: "text", label: "SKU" },
    { name: "price", type: "number", label: "Price", required: true, min: 0 },
    { name: "brand", type: "text", label: "Brand" },
    {
      name: "images",
      type: "media",
      label: "Product images",
      required: true,
      multiple: true,
      min: 2,
    },
    { name: "body", type: "richtext", label: "Description" },
    {
      name: "specs",
      type: "component",
      label: "Specs",
      component: "product-specs",
    },
    {
      name: "variants",
      type: "variant_axis",
      label: "Options",
      axes: [
        { name: "Colour", options: ["Black", "White", "Silver"] },
        { name: "Bundle", options: ["Default", "Full package"] },
      ],
    },
    {
      name: "related",
      type: "relation",
      label: "Related products",
      target: "product",
      relationKind: "manyToMany",
      predicate: "related_to", // KG slot (§2.7)
    },
    {
      name: "compatibleWith",
      type: "relation",
      label: "Compatible with",
      target: "product",
      relationKind: "manyToMany",
      predicate: "compatible_with",
    },
  ],
} as unknown as ContentTypeDefinition;

export const PRESETS: PresetBundle[] = [
  {
    id: "product",
    name: "Product",
    description: "variant axis · attribute set · predicate · schema.org — the full PIM setup",
    contentType: {
      uid: "product",
      kind: ContentTypeKind.Collection,
      name: "Product",
      schemaOrgType: "Product",
      definition: productDefinition,
    },
    components: [
      {
        uid: "product-specs",
        name: "Product specs",
        definition: {
          fields: [
            { name: "weight", type: "text", label: "Weight" },
            { name: "dimensions", type: "text", label: "Dimensions" },
            { name: "material", type: "text", label: "Material" },
            { name: "origin", type: "text", label: "Origin" },
          ],
        } as unknown as ContentTypeDefinition,
      },
    ],
  },
  {
    id: "article",
    name: "Article",
    description: "Title · rich text body · cover image · publish date",
    contentType: {
      uid: "article",
      kind: ContentTypeKind.Collection,
      name: "Article",
      schemaOrgType: "Article",
      definition: {
        displayField: "title",
        fields: [
          { name: "title", type: "text", label: "Title", required: true, maxLength: 200 },
          { name: "slug", type: "text", label: "Slug" },
          { name: "cover", type: "media", label: "Cover image" },
          { name: "body", type: "richtext", label: "Body", required: true },
          { name: "publishDate", type: "date", label: "Publish date" },
          { name: "author", type: "text", label: "Author" },
        ],
      } as unknown as ContentTypeDefinition,
    },
  },
  {
    id: "faq",
    name: "FAQ",
    description: "Question · answer · category",
    contentType: {
      uid: "faq",
      kind: ContentTypeKind.Collection,
      name: "FAQ",
      schemaOrgType: "FAQPage",
      definition: {
        displayField: "question",
        fields: [
          { name: "question", type: "text", label: "Question", required: true },
          { name: "answer", type: "richtext", label: "Answer", required: true },
          {
            name: "category",
            type: "enum",
            label: "Category",
            options: ["Product", "Shipping", "Payment", "Other"],
          },
          { name: "pinned", type: "boolean", label: "Pinned" },
        ],
      } as unknown as ContentTypeDefinition,
    },
  },
  {
    id: "event",
    name: "Event",
    description: "Schedule · location · description · schema.org/Event",
    contentType: {
      uid: "event",
      kind: ContentTypeKind.Collection,
      name: "Event",
      schemaOrgType: "Event",
      definition: {
        displayField: "name",
        fields: [
          { name: "name", type: "text", label: "Event name", required: true },
          { name: "startDate", type: "date", label: "Starts", required: true, withTime: true },
          { name: "endDate", type: "date", label: "Ends", withTime: true },
          { name: "location", type: "text", label: "Location" },
          { name: "description", type: "richtext", label: "Description" },
          { name: "cover", type: "media", label: "Cover image" },
        ],
      } as unknown as ContentTypeDefinition,
    },
  },
];

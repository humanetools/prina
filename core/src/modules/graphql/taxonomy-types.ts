/**
 * GraphQL types for taxonomy on the delivery plane (22-IMPL-delivery-taxonomy): the nodes an entry sits
 * in (with the node's attributes and the entry's entry-component values), and the classification trees. Field maps are thunks — this
 * module and schema.ts import each other (JSON scalar), so nothing is read at module evaluation.
 */
import {
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
} from "graphql";
import type { GqlContext } from "./execute.js";
import { JSONScalar } from "./schema.js";

export const TAXONOMY_TYPE_NAMES = ["EntryTaxonomy", "Taxonomy", "TaxonomyNode"];

export const EntryTaxonomyType = new GraphQLObjectType({
  name: "EntryTaxonomy",
  description: "A taxonomy node this entry is classified under",
  fields: () => ({
    taxonomy: { type: new GraphQLNonNull(GraphQLString), description: "Taxonomy uid" },
    nodeId: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: new GraphQLNonNull(GraphQLString) },
    path: { type: new GraphQLNonNull(GraphQLString), description: "Dot path inside the taxonomy, e.g. accessories.chargers" },
    attributes: { type: new GraphQLNonNull(JSONScalar), description: "The node's own attribute values (taxonomy attributeFields)" },
    entryComponent: { type: GraphQLString, description: "Component uid of the node's entry component" },
    entryComponentValues: { type: JSONScalar, description: "What this entry filled in for the node's entry component (media / relations resolved)" },
  }),
});

const TaxonomyNodeType = new GraphQLObjectType({
  name: "TaxonomyNode",
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLID) },
    parentId: { type: GraphQLID },
    name: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: new GraphQLNonNull(GraphQLString) },
    path: { type: new GraphQLNonNull(GraphQLString) },
    depth: { type: new GraphQLNonNull(GraphQLInt) },
    position: { type: new GraphQLNonNull(GraphQLInt) },
    attributes: { type: new GraphQLNonNull(JSONScalar), description: "The node's attribute values" },
    entryComponent: { type: GraphQLString, description: "Component uid entries under this node fill in" },
  }),
});

const TaxonomyType = new GraphQLObjectType<{ uid: string }, GqlContext>({
  name: "Taxonomy",
  fields: () => ({
    uid: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    attributeFields: { type: new GraphQLNonNull(JSONScalar), description: "Attribute definitions every node carries values for: [{ name, label, type, multiline }]" },
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TaxonomyNodeType))),
      description: "Flat, path-ordered (parents before children) — assemble the tree from parentId",
      resolve: async (src, _args, ctx) => (await ctx.taxonomy(src.uid))?.nodes ?? [],
    },
  }),
});

/** `taxonomies` field on every entry type */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- entry object types are declared with an untyped source
export const entryTaxonomiesField: GraphQLFieldConfig<any, GqlContext> = {
  type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(EntryTaxonomyType))),
  description: "Taxonomy nodes this entry sits in — each with the node's attributes and this entry's entry-component values",
  resolve: (src: { __meta: { id: string } }, _args, ctx) => ctx.entryTaxonomies(src.__meta.id),
};

/** Query roots — names are claimed by the caller so a content type called `taxonomy` keeps its root */
export function taxonomyQueryFields(names: { list: string; one: string }): GraphQLFieldConfigMap<unknown, GqlContext> {
  return {
    [names.list]: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TaxonomyType))),
      description: "Taxonomies of this workspace",
      resolve: (_s, _a, ctx) => ctx.taxonomies(),
    },
    [names.one]: {
      type: TaxonomyType,
      description: "One taxonomy by uid",
      args: { uid: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: (_s, args: { uid: string }, ctx) => ctx.taxonomy(args.uid),
    },
  };
}

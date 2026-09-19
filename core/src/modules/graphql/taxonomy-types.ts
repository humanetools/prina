/**
 * GraphQL types for taxonomy on the delivery plane (22-IMPL-delivery-taxonomy): the nodes an entry sits
 * in (with attribute-set values), and the classification trees themselves. Field maps are thunks — this
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
    attributeSet: { type: GraphQLString, description: "Component uid of the node's attribute set" },
    attributes: { type: JSONScalar, description: "Attribute-set values of this entry for this node (media / relations resolved)" },
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
    attributeSet: { type: GraphQLString },
  }),
});

const TaxonomyType = new GraphQLObjectType<{ uid: string }, GqlContext>({
  name: "Taxonomy",
  fields: () => ({
    uid: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
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
  description: "Taxonomy nodes this entry sits in, with attribute-set values",
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

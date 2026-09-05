# Prina

**The MCP-native headless CMS — build admin pages easily.**

Prina is a content engine with a schema-driven admin UI, digital asset management,
flexible delivery (JSON / HTML fragments / embeddable widgets), and a first-class
[MCP](https://modelcontextprotocol.io) server: every feature is exposed as MCP tools,
so AI agents can manage and consume your content out of the box.

## Quickstart (Docker)

```bash
git clone https://github.com/humanetools/prina.git
cd prina/install
./install.sh          # generates .env (random secrets), pulls the image, starts the stack
```

Then open `http://localhost:3000/admin` and follow the setup wizard.
Images are published at [`ghcr.io/humanetools/prina`](https://github.com/humanetools/prina/pkgs/container/prina) — versioned tags only, no `latest`.

**Update (manual):** edit `PRINA_VERSION` in `.env`, then
`docker compose pull && docker compose up -d`.

## Features

- **Content-Type Builder** — schema as the single source of truth (validation, OpenAPI, MCP tools are all generated from it)
- **Content Manager** — schema-driven forms, rich text (ProseMirror), variants, completeness scoring, draft/publish
- **DAM** — S3-compatible storage, presigned uploads, image renditions (imgproxy), usage tracking
- **Delivery** — JSON API, Liquid HTML fragments, `embed.js` widgets, GA4 dataLayer
- **MCP server (2 planes)** — management plane (role-bound tokens) + delivery plane (published content only)
- **AI, BYOK** — schema generation, semantic search (pgvector + FTS fusion) with your own API keys
- **Knowledge graph** — JSON-LD, multi-hop traversal
- **i18n, taxonomies (ltree), CSV/Excel import, type presets**

## SEO · GEO · Accessibility

Our goal: content should leave the CMS already clean for **search engines, AI
engines, and assistive technology** — not patched up afterwards in the frontend.

- **SEO** — JSON-LD structured data (schema.org types & semantic predicates),
  a built-in per-type SEO panel (meta title/description, canonical URL
  patterns, OG tags, noindex), head-snippet delivery (`?format=head`), and
  `sitemap.xml` / `robots.txt` — all ship today.
- **GEO** (Generative Engine Optimization) — the MCP delivery plane and the
  knowledge graph make content directly consumable and citable by AI agents,
  and every workspace serves an `llms.txt` content survey.
- **Accessibility** — semantic delivery markup plus authoring-time checks:
  two-level alt text (asset default + per-usage override) with publish
  advisories, a WCAG contrast & structure audit in the live preview, and
  text-overlay contrast analysis on uploaded images.

Looking for approval workflows, custom roles & field-level permissions, audit log UI,
version history & restore, automatic updates, or white-labeling?
Those ship in the [commercial edition](#commercial-edition).

## Build from source

Requirements: Node 20+, pnpm 9 (via corepack), Docker (or a local Postgres).

```bash
# backend (serves the admin build too)
cd core
pnpm install
pnpm dev:db          # terminal 1: embedded Postgres on :5433
PORT=3100 DATABASE_URL=postgres://postgres:postgres@localhost:5433/prina \
  ADMIN_DIST_PATH=../admin/dist pnpm dev   # terminal 2

# admin UI
cd admin
pnpm install && pnpm build   # or `pnpm dev` for the Vite dev server

# tests (spins up its own embedded Postgres)
cd core && pnpm test
```

## Commercial edition

The open-source core is a complete CMS. The commercial edition adds features
organizations need — approval workflows, custom roles and field-level
permissions, audit log tooling, version history & restore, automatic updates,
white-labeling, and priority support. Contact us via GitHub issues for now.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and feature discussions are
very welcome. Note that this repository is a read-only mirror synchronized from
our main development repository at each release — PRs are ported by maintainers.

## Security

Please report vulnerabilities privately via
[GitHub Security Advisories](../../security/advisories/new) — do not open public issues.
See [SECURITY.md](SECURITY.md).

## License

The contents of this repository are licensed under the [Apache License 2.0](LICENSE).
Commercial-edition code is not included in this repository and is licensed separately.

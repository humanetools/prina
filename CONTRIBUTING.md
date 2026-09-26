# Contributing to Prina

Thanks for your interest! A few things to know before you start.

## How this repository works

This is a **release mirror** of our main development repository: at each release the
open-source tree (core + admin, commercial code excluded) is synchronized here as a
single commit. That means:

- **Issues are the best way to contribute** — bug reports, feature discussions, and
  design feedback are read by the maintainers and acted on in the main repository.
- **Pull requests are welcome but are ported, not merged** — a maintainer applies your
  change to the main repository (with credit), and it appears here at the next release.

## Contributor License Agreement (CLA)

By submitting a pull request you agree that:

1. You are the author of the contribution (or have the right to submit it), and
2. You grant HumaneTools a perpetual, worldwide, irrevocable license to use, modify,
   relicense, and distribute your contribution, including under licenses other than
   Apache-2.0 (this keeps our open-core dual-licensing possible).

The full text is in [CLA.md](CLA.md). The pull-request template includes a mandatory
CLA agreement checkbox — PRs without it checked are not ported. A CLA bot
(merge-blocking) will be added as the project grows.

## Development setup

See the [Build from source](README.md#build-from-source) section of the README.
Useful commands:

| command | where | what |
| :--- | :--- | :--- |
| `pnpm dev:db` | `core/` | embedded Postgres on :5433 |
| `pnpm dev` | `core/` | API + MCP server (serves `admin/dist` if built) |
| `pnpm test` | `core/` | full test suite (self-contained) |
| `pnpm typecheck` / `pnpm lint` | `core/` | static checks |
| `pnpm build` | `admin/` | production admin build |

## Code style

- Match the surrounding code — comment density, naming, and idioms.
- Enums over string comparison; shared enums live in `core/packages/shared` and are
  mirrored in `admin/src/api/types.ts` (keep both in sync).
- Keep files under ~300 lines where practical; one file, one responsibility.

# Prina OSS — Docker install

Installs the open-source edition of Prina with Docker Compose.
(Compared to the commercial edition: approval workflows, audit log UI, custom
roles, version history/restore, and automatic updates are not included.)

## Requirements

- Docker Engine + Compose v2
- One open port (default 3000)

## Install

```bash
./install.sh
```

When prompted, enter a release tag (e.g. `0.3.0`). A `.env` file is generated
with random secrets, the stack is pulled and started, and the script waits for
the health check. When it finishes, open the printed URL and complete the
setup wizard.

## Update (manual)

```bash
# change PRINA_VERSION in .env to the desired tag, then:
docker compose pull && docker compose up -d
```

Installs created before 2026-10-23 run `darthsim/imgproxy:v3.27`, whose bundled Brotli has a
remote-code-execution flaw (CVE-2026-111497) that no upstream imgproxy image has fixed yet.
Edit `docker-compose.yml` and set the `imgproxy` service image to
`ghcr.io/humanetools/imgproxy:v3.27.2-brotli1.1.1` (the same image with Brotli 1.1.1 swapped in),
then `docker compose pull imgproxy && docker compose up -d imgproxy`. Prina ≥ 0.5.16 also refuses
JPEG XL uploads, which is the path that reaches that decoder, so an un-swapped install is
mitigated but not fixed.

## Services

- `postgres` — bundled with pgvector (semantic search)
- `minio` + `minio-init` — S3-compatible storage, served by RustFS (the service keeps the historical name `minio`; remove both and set `S3_*` to use your own S3). Bucket creation uses `amazon/aws-cli` purely as an S3 client against the local RustFS — no AWS account is involved.
- `imgproxy` — image renditions
- `core` — Prina itself (API + Admin + MCP)

## Data

- Database: `pgdata` volume · Assets: `miniodata` volume
- `docker compose down` keeps your data. Adding `-v` **deletes everything**.

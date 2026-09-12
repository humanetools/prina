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

## Services

- `postgres` — bundled with pgvector (semantic search)
- `minio` + `minio-init` — S3-compatible storage (remove and set `S3_*` to use your own S3)
- `imgproxy` — image renditions
- `core` — Prina itself (API + Admin + MCP)

## Data

- Database: `pgdata` volume · Assets: `miniodata` volume
- `docker compose down` keeps your data. Adding `-v` **deletes everything**.

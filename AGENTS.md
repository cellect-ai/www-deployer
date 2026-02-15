# www-deployer — Agent guide

**Purpose:** Multi-site webhook deployer for cellect.ai websites. Listens for GitHub push webhooks and builds/deploys each site as its own Docker container; Caddy on another VM reverse-proxies by domain.

## For agents

- **Config:** `sites.json` — list of deploy targets (repo, `branch` or `branches`, port, container_name, domain, node_version, optional build_cmd/serve_cmd). This file is **mounted read-only** into the deployer container; edit on host and restart deployer to apply (no image rebuild).
- **Entrypoint:** `app.js` — Express server; `POST /hooks` handles GitHub webhooks, `GET /health` for liveness.
- **Deploy flow:** On push webhook → load `sites.json` → find target by `repository.full_name` + pushed branch (supports `branch` or `branches`) → clone/pull and checkout pushed branch into `REPOS_BASE/<container_name>` → build image (site Dockerfile or `templates/Dockerfile.default` with build_cmd/serve_cmd) → `docker rm -f` old container → `docker run` new one on target port (host:port → 3000).
- **Secrets:** Infisical supplies `WWW_GIT_DEPLOY_SECRET` (webhook HMAC), `GITHUB_TOKEN` (clone), `WWW_GIT_REPOS_PATH`, `WWW_GIT_DEPLOY_PORT`, etc. Container logs in with Infisical at startup.
- **Port:** Default 9000 in container; host port from `WWW_GIT_DEPLOY_PORT` (e.g. 9009). Webhook URL: `https://ops.cellect.ai/git_www/hooks`.

## Key paths

| Path | Role |
|------|------|
| `sites.json` | Site list; mounted into container. Edit on host, then `docker compose restart deployer`. |
| `app.js` | Webhook server and deploy logic. |
| `manage.sh` | Interactive/CLI: check or configure GitHub webhooks, manual deploy. Needs `.env` and Infisical. `./manage.sh deploy cellect-ai/<repo>` triggers deploy for that repo. |
| `templates/Dockerfile.default` | Used when repo has no Dockerfile; substitutes `NODE_VERSION`, `BUILD_CMD`, `SERVE_CMD`. |
| `docker-compose.yaml` | Runs deployer; mounts `./sites.json:/app/sites.json:ro`, repos volume, docker.sock. |
| `/repos/_www_deployer_logs/www-deployer.log` | Persistent deployer log file on repos volume (timestamped). |
| `/repos/_www_deployer_logs/www-deployer-*.log` | Rotated deployer logs (size-based rotation at startup). |

## Adding a new site

1. **Edit `sites.json`** — add object with `repo`, `branch` (or `branches` array), `port` (unique), `container_name`, `domain`, `node_version`; for static sites add `build_cmd` (e.g. `echo 'no build'`) and `serve_cmd` (e.g. `npx serve -l 3000`).
2. **Restart deployer:** `docker compose restart deployer` (or `up -d` to apply volume changes).
3. **Webhook:** Either add in GitHub repo (Settings → Webhooks → URL `https://ops.cellect.ai/git_www/hooks`, secret from Infisical `WWW_GIT_DEPLOY_SECRET`, event: push) or run `./manage.sh configure` and answer yes to configure missing webhooks.
4. **First deploy:** Push to the repo, or run `./manage.sh deploy cellect-ai/<repo>`.
5. **Caddy:** On the Caddy VM, add a block for the site’s `domain` with `reverse_proxy <deployer-host-ip>:<port>`.

## Setup (human / one-time)

- **Infisical:** `WWW_GIT_DEPLOY_SECRET`, `GITHUB_TOKEN`, `WWW_GIT_REPOS_PATH` (e.g. `/mnt/pve/nfs-cellect-repos`), `WWW_GIT_DEPLOY_PORT` (e.g. `9009`). See INFISICAL_SETUP.md if present.
- **Local:** `cp .env.example .env`, fill Infisical client id/secret, workspace, env, path.
- **Run:** `docker compose up -d` from this directory.

## Troubleshooting

- **“Ignored: unconfigured repo”** — repo not in `sites.json` or deployer not restarted after editing it; ensure `sites.json` is mounted and container was restarted.
- **Deploy fails (clone/build/run):** Check `docker logs www-deployer`. Repos live under `WWW_GIT_REPOS_PATH`; containers are named by `container_name` and listen on host at `port`.
- **Logs growing too large:** tune `WWW_DEPLOYER_LOG_MAX_BYTES` and `WWW_DEPLOYER_LOG_KEEP_FILES` in `.env`.
- **Webhook 403:** Signature mismatch; secret in GitHub must match Infisical `WWW_GIT_DEPLOY_SECRET`.
- **Manual deploy:** `./manage.sh deploy cellect-ai/<repo>` (requires .env and Infisical for signing the local webhook request).

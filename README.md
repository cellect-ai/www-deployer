# www-deployer

Multi-site webhook deployer for cellect.ai websites.

## Overview

This service listens for GitHub webhooks and automatically builds and deploys website containers when code is pushed. Each site gets its own Docker container with a published port that Caddy (running on a separate VM) can route to.

## Setup

1. **Prerequisites:**
   ```bash
   cd /root/cellect
   # www-deployer is already in the cellect folder structure
   ```

2. **Verify NFS repos directory:**
   ```bash
   ls -la /mnt/pve/nfs-cellect-repos
   # Should be mounted and accessible
   ```

3. **Add secrets to Infisical:**
   
   In your Infisical project (environment: prod/dev/etc), add these secrets:
   - `WWW_GIT_DEPLOY_SECRET` - Generate with: `openssl rand -hex 32`
   - `GITHUB_TOKEN` - Fine-grained PAT with Contents read on www-* repos
   - `WWW_GIT_REPOS_PATH` - Set to: `/mnt/pve/nfs-cellect-repos`
   - `WWW_GIT_DEPLOY_PORT` - Set to: `9009`
   
   See [INFISICAL_SETUP.md](INFISICAL_SETUP.md) for detailed instructions.

4. **Configure local environment:**
   ```bash
   cd /root/cellect/www-deployer
   cp .env.example .env
   
   # Edit .env with your Infisical connection details:
   # INFISICAL_CLIENT_ID=<your-client-id>
   # INFISICAL_CLIENT_SECRET=<your-client-secret>
   # INFISICAL_API_URL=https://app.infisical.com
   # INFISICAL_WORKSPACE_ID=<your-project-id>
   # INFISICAL_ENV=prod  # or dev, staging
   # INFISICAL_PATH=/
   
   # You can copy these from /root/cellect/core/.env or /app/.env
   ```

4. **Start the deployer:**
   ```bash
   cd /root/cellect/www-deployer
   docker compose up -d
   ```

5. **Configure GitHub webhooks:**
   For each site repo (e.g., cellect-ai/www-v0):
   - Go to Settings → Webhooks → Add webhook
   - Payload URL: `https://ops.cellect.ai/git_www/hooks`
   - Content type: `application/json`
   - Secret: (use `WWW_GIT_DEPLOY_SECRET` value from Infisical)
   - Events: Just the push event
   - Active: ✓

6. **Add sites to sites.json:**
   Edit `sites.json` to configure which repos to deploy, their ports, etc.

7. **Configure Caddy routing:**
   On your Caddy VM, add reverse_proxy entries for each site:
   ```
   preview.cellect.ai {
       reverse_proxy 192.168.5.195:9090
   }
   ```

## Architecture

- One webhook endpoint handles all repos
- Each repo push triggers a build+deploy for that specific site
- Sites run in isolated containers on their own ports
- Caddy routes subdomains to the appropriate container ports

## Adding a new site

1. Add entry to `sites.json`:
   ```json
   {
     "repo": "cellect-ai/www-v1",
     "branch": "main",
     "port": 9091,
     "container_name": "www-v1",
     "domain": "v1.cellect.ai",
     "node_version": "22",
     "build_cmd": "npm install && npm run build",
     "serve_cmd": "npx serve -s dist -l 3000"
   }
   ```

2. Restart deployer: `docker compose restart deployer`

3. Add GitHub webhook to the new repo

4. Add Caddy route for the new domain

5. Test by pushing to the repo

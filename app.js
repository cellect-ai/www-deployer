const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

const CONFIG_PATH = path.join(__dirname, 'sites.json');
const WEBHOOK_SECRET = process.env.WWW_GIT_DEPLOY_SECRET || process.env.WEBHOOK_SECRET || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GIT_DEPLOY_USER_PAT || '';
// Use DOCKER_NETWORK from Infisical, but if it's 'cellect' (swarm), use local default
const INFISICAL_NETWORK = process.env.DOCKER_NETWORK || '';
const DOCKER_NETWORK = (INFISICAL_NETWORK === 'cellect') ? 'www-deployer_default' : (INFISICAL_NETWORK || 'www-deployer_default');
const PORT = process.env.PORT || 9000;
const HOST = process.env.HOST || '0.0.0.0';
const REPOS_BASE = process.env.WWW_GIT_REPOS_PATH || process.env.REPOS_PATH || '/repos';
const INFISICAL_PROJECT_ID = process.env.INFISICAL_WORKSPACE_ID || '';
const INFISICAL_ENV = process.env.INFISICAL_ENV || '';
const INFISICAL_PATH = process.env.INFISICAL_PATH || '/';
const INFISICAL_API_URL = process.env.INFISICAL_API_URL || '';
const INFISICAL_TOKEN_CACHE = new Map();
const SERVICE_NAME = 'www-deployer';

function logEvent(level, message, meta = {}) {
    const payload = {
        ts: new Date().toISOString(),
        service: SERVICE_NAME,
        level,
        message,
        ...meta
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logInfo(message, meta = {}) {
    logEvent('info', message, meta);
}

function logWarn(message, meta = {}) {
    logEvent('warn', message, meta);
}

function logError(message, meta = {}) {
    logEvent('error', message, meta);
}

function redactSecrets(text) {
    if (typeof text !== 'string') return text;
    return text
        // Infisical tokens / JWTs
        .replace(/INFISICAL_TOKEN='[^']*'/g, "INFISICAL_TOKEN='<redacted>'")
        .replace(/--token='[^']*'/g, "--token='<redacted>'")
        // GitHub token-in-URL
        .replace(/https:\/\/x-access-token:[^@]+@github\.com/g, "https://x-access-token:<redacted>@github.com")
        // Generic PAT markers
        .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_<redacted>");
}

function errorMeta(err) {
    if (!err) return {};
    return {
        error: redactSecrets(err.message),
        status: err.status,
        signal: err.signal
    };
}

function getSiteBranches(site) {
    if (Array.isArray(site.branches) && site.branches.length > 0) {
        return site.branches;
    }
    if (typeof site.branch === 'string' && site.branch.trim()) {
        return [site.branch.trim()];
    }
    return [];
}

function isSafeRefName(ref) {
    return typeof ref === 'string' && /^[A-Za-z0-9._/-]+$/.test(ref);
}

function shellEscape(value) {
    return String(value).replace(/'/g, `'\\''`);
}

function getCloneUrl(repoFullName) {
    return GITHUB_TOKEN
        ? `https://x-access-token:${GITHUB_TOKEN}@github.com/${repoFullName}.git`
        : `https://github.com/${repoFullName}.git`;
}

function remoteBranchExists(cloneUrl, branch) {
    if (!isSafeRefName(branch)) return false;
    try {
        const output = execSync(`git ls-remote --heads ${cloneUrl} ${branch}`, { encoding: 'utf8' }).trim();
        return output.length > 0;
    } catch (err) {
        logWarn('Failed to check remote branch', { branch, ...errorMeta(err) });
        return false;
    }
}

function resolveInfisicalConfig(site) {
    if (site.infisical_enabled === false) {
        return null;
    }

    const clientId = site.infisical_client_id || process.env.INFISICAL_CLIENT_ID || '';
    const clientSecret = site.infisical_client_secret || process.env.INFISICAL_CLIENT_SECRET || '';
    const projectId = site.infisical_project_id || INFISICAL_PROJECT_ID;
    const env = site.infisical_env || INFISICAL_ENV;
    const secretPath = site.infisical_path || INFISICAL_PATH;
    const domain = site.infisical_api_url || INFISICAL_API_URL;

    if (!clientId || !clientSecret || !projectId || !env || !domain) {
        return null;
    }

    return {
        clientId,
        clientSecret,
        projectId,
        env,
        secretPath,
        domain
    };
}

function imageHasInfisical(imageTag) {
    try {
        execSync(`docker run --rm --entrypoint /bin/sh ${imageTag} -lc "command -v infisical >/dev/null 2>&1"`, { stdio: 'pipe' });
        return true;
    } catch (err) {
        return false;
    }
}

function imageHasApk(imageTag) {
    try {
        execSync(`docker run --rm --entrypoint /bin/sh ${imageTag} -lc "command -v apk >/dev/null 2>&1"`, { stdio: 'pipe' });
        return true;
    } catch (err) {
        return false;
    }
}

function ensureInfisicalInImage(imageTag) {
    if (imageHasInfisical(imageTag)) {
        return true;
    }
    if (!imageHasApk(imageTag)) {
        return false;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployer-infisical-'));
    const dockerfilePath = path.join(tmpDir, 'Dockerfile');
    const dockerfile = [
        `FROM ${imageTag}`,
        "RUN apk add --no-cache curl bash && \\",
        "    curl -1sLf 'https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.alpine.sh' | bash && \\",
        "    apk add --no-cache infisical"
    ].join('\n');

    try {
        fs.writeFileSync(dockerfilePath, dockerfile);
        execSync(`docker build -t ${imageTag} -f ${dockerfilePath} ${tmpDir}`, { stdio: 'inherit' });
        return imageHasInfisical(imageTag);
    } finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (err) {
            // best-effort cleanup
        }
    }
}

function getStartCommand(site, usedSiteDockerfile) {
    if (typeof site.serve_cmd === 'string' && site.serve_cmd.trim()) {
        return site.serve_cmd.trim();
    }
    if (!usedSiteDockerfile) {
        return 'npx serve -s dist -l 3000';
    }
    return null;
}

function getMachineIdentityToken(infisicalConfig) {
    const cacheKey = `${infisicalConfig.clientId}|${infisicalConfig.domain}`;
    if (INFISICAL_TOKEN_CACHE.has(cacheKey)) {
        return INFISICAL_TOKEN_CACHE.get(cacheKey);
    }

    const loginCmd = `infisical login --method=universal-auth --client-id='${shellEscape(infisicalConfig.clientId)}' --client-secret='${shellEscape(infisicalConfig.clientSecret)}' --silent --plain --domain='${shellEscape(infisicalConfig.domain)}'`;
    const token = execSync(loginCmd, { encoding: 'utf8' }).trim();
    INFISICAL_TOKEN_CACHE.set(cacheKey, token);
    return token;
}

function deploySite(repoFullName, site, sourceBranch, deployId) {
    if (!isSafeRefName(sourceBranch)) {
        throw new Error(`Unsafe branch name: ${sourceBranch}`);
    }

    const repoDir = path.join(REPOS_BASE, site.container_name);
    const cloneUrl = getCloneUrl(repoFullName);

    // Clone or pull repository and sync to the chosen source branch
    if (!fs.existsSync(repoDir)) {
        logInfo('Cloning repository', { deployId, repo: repoFullName, branch: sourceBranch, container: site.container_name });
        execSync(`git clone --branch ${sourceBranch} --single-branch ${cloneUrl} ${repoDir}`, { stdio: 'inherit' });
    } else {
        logInfo('Pulling repository', { deployId, repo: repoFullName, branch: sourceBranch, container: site.container_name });
        execSync(`git -C ${repoDir} fetch origin ${sourceBranch}`, { stdio: 'inherit' });
        execSync(`git -C ${repoDir} checkout -B ${sourceBranch} origin/${sourceBranch}`, { stdio: 'inherit' });
        execSync(`git -C ${repoDir} reset --hard origin/${sourceBranch}`, { stdio: 'inherit' });
    }

    // Build Docker image
    logInfo('Building site image', { deployId, container: site.container_name });

    // Check if site has its own Dockerfile, otherwise use template
    const siteDockerfile = path.join(repoDir, 'Dockerfile');
    const usedSiteDockerfile = fs.existsSync(siteDockerfile);
    let buildCmd;

    if (usedSiteDockerfile) {
        logInfo('Using site Dockerfile', { deployId, container: site.container_name });
        buildCmd = `docker build -t ${site.container_name}:latest ${repoDir}`;
    } else {
        logInfo('Using default Dockerfile template', { deployId, container: site.container_name });
        const templatePath = path.join(__dirname, 'templates', 'Dockerfile.default');
        const tempDockerfile = path.join(repoDir, '.Dockerfile.tmp');

        // Generate Dockerfile from template
        let template = fs.readFileSync(templatePath, 'utf8');
        template = template.replace(/\$\{NODE_VERSION\}/g, site.node_version || '22');
        template = template.replace(/\$\{BUILD_CMD\}/g, site.build_cmd || 'npm install && npm run build');
        template = template.replace(/\$\{SERVE_CMD\}/g, site.serve_cmd || 'npx serve -s dist -l 3000');

        fs.writeFileSync(tempDockerfile, template);
        buildCmd = `docker build -t ${site.container_name}:latest -f ${tempDockerfile} ${repoDir}`;
    }

    execSync(buildCmd, { stdio: 'inherit' });

    // Stop and remove old container if exists
    try {
        logInfo('Stopping old container', { deployId, container: site.container_name });
        execSync(`docker rm -f ${site.container_name}`, { stdio: 'inherit' });
    } catch (err) {
        // Container might not exist, that's fine
    }

    // Start new container
    logInfo('Starting site container', { deployId, container: site.container_name, port: site.port });
    const imageTag = `${site.container_name}:latest`;
    let runCmd = `docker run -d \
        --name ${site.container_name} \
        --network ${DOCKER_NETWORK} \
        --restart unless-stopped \
        -p ${site.port}:3000 \
        ${imageTag}`;

    const infisicalConfig = resolveInfisicalConfig(site);
    if (infisicalConfig) {
        const startCommand = getStartCommand(site, usedSiteDockerfile);
        if (!startCommand) {
            logWarn('Infisical runtime skipped: set serve_cmd for custom Dockerfile target', { deployId, container: site.container_name });
        } else {
            const infisicalReady = imageHasInfisical(imageTag) || ensureInfisicalInImage(imageTag);
            if (!infisicalReady) {
                logWarn('Infisical runtime skipped: unable to add infisical to image', { deployId, container: site.container_name });
                execSync(runCmd, { stdio: 'inherit' });
                return;
            }

            let machineIdentityToken = '';
            try {
                machineIdentityToken = getMachineIdentityToken(infisicalConfig);
            } catch (err) {
                logWarn('Infisical runtime skipped: machine identity auth failed', { deployId, container: site.container_name, ...errorMeta(err) });
            }

            if (!machineIdentityToken) {
                // fall back to default container startup
                execSync(runCmd, { stdio: 'inherit' });
                return;
            }

            runCmd = `docker run -d \
        --name ${site.container_name} \
        --network ${DOCKER_NETWORK} \
        --restart unless-stopped \
        -p ${site.port}:3000 \
        -e INFISICAL_API_URL='${shellEscape(infisicalConfig.domain)}' \
        --entrypoint infisical \
        ${imageTag} \
        run --token='${shellEscape(machineIdentityToken)}' --projectId='${shellEscape(infisicalConfig.projectId)}' --env='${shellEscape(infisicalConfig.env)}' --path='${shellEscape(infisicalConfig.secretPath)}' --domain='${shellEscape(infisicalConfig.domain)}' --command='${shellEscape(startCommand)}'`;
            logInfo('Infisical runtime enabled', { deployId, container: site.container_name });
        }
    } else {
        logInfo('Infisical runtime skipped: missing config', { deployId, container: site.container_name });
    }

    execSync(runCmd, { stdio: 'inherit' });
}

app.post('/hooks', async (req, res) => {
    const deployId = crypto.randomUUID();
    const startedAt = Date.now();
    logInfo('Webhook received', { deployId });
    
    // Verify webhook signature
    if (WEBHOOK_SECRET) {
        const signature = req.headers['x-hub-signature-256'];
        const payloadBuffer = req.rawBody || Buffer.from('');
        const computedSig = 'sha256=' + crypto
            .createHmac('sha256', WEBHOOK_SECRET)
            .update(payloadBuffer)
            .digest('hex');
        if (signature !== computedSig) {
            logError('Invalid webhook signature', { deployId });
            return res.status(403).send('Invalid signature');
        }
    }

    // Get repository info from payload
    const repoFullName = req.body.repository?.full_name;
    const branch = req.body.ref?.replace('refs/heads/', '');
    
    if (!repoFullName) {
        return res.status(400).send('Missing repository information');
    }

    logInfo('Webhook push event', { deployId, repo: repoFullName, branch });

    // Load sites config
    let config;
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
        logError('Failed to load sites config', { deployId, ...errorMeta(err) });
        return res.status(500).send('Config error');
    }

    if (!isSafeRefName(branch)) {
        return res.status(400).send('Invalid branch name');
    }

    // Find configured targets for this repo
    const repoSites = config.sites.filter(s => s.repo === repoFullName);
    if (repoSites.length === 0) {
        logInfo('Webhook ignored: unconfigured repo', { deployId, repo: repoFullName });
        return res.status(200).send(`Ignored: unconfigured repo ${repoFullName}`);
    }

    const cloneUrl = getCloneUrl(repoFullName);
    const matchingSites = repoSites.filter(s => getSiteBranches(s).includes(branch));
    const deployTargets = matchingSites.map(site => ({ site, sourceBranch: branch }));

    // Preview fallback: on main/master push, deploy preview target from main if preview branch is missing.
    if (branch === 'main' || branch === 'master') {
        const previewBranchExists = remoteBranchExists(cloneUrl, 'preview');
        if (!previewBranchExists) {
            const previewSites = repoSites.filter(s => getSiteBranches(s).includes('preview'));
            for (const previewSite of previewSites) {
                deployTargets.push({ site: previewSite, sourceBranch: branch });
                logInfo('Preview fallback enabled', { deployId, repo: repoFullName, container: previewSite.container_name, sourceBranch: branch });
            }
        }
    }

    if (deployTargets.length === 0) {
        const allowedBranches = Array.from(new Set(repoSites.flatMap(getSiteBranches)));
        logInfo('Webhook ignored: branch not configured', { deployId, branch, allowedBranches });
        return res.status(200).send(`Ignored: not a configured branch (${branch})`);
    }

    try {
        const deployedContainers = [];
        for (const target of deployTargets) {
            deploySite(repoFullName, target.site, target.sourceBranch, deployId);
            deployedContainers.push(target.site.container_name);
        }
        logInfo('Deployment completed', { deployId, repo: repoFullName, branch, containers: deployedContainers, durationMs: Date.now() - startedAt });
        res.status(200).send(`Deployed: ${deployedContainers.join(', ')}`);
    } catch (err) {
        logError('Deployment failed', { deployId, repo: repoFullName, branch, ...errorMeta(err) });
        res.status(500).send(`Error: ${err.message}`);
    }
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.listen(PORT, HOST, () => {
    logInfo('Webhook server started', { host: HOST, port: PORT, dockerNetwork: DOCKER_NETWORK, reposBase: REPOS_BASE });
});

const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

app.post('/hooks', async (req, res) => {
    console.log('Received webhook');
    
    // Verify webhook signature
    if (WEBHOOK_SECRET) {
        const signature = req.headers['x-hub-signature-256'];
        const payloadBuffer = req.rawBody || Buffer.from('');
        const computedSig = 'sha256=' + crypto
            .createHmac('sha256', WEBHOOK_SECRET)
            .update(payloadBuffer)
            .digest('hex');
        if (signature !== computedSig) {
            console.error('Invalid signature');
            return res.status(403).send('Invalid signature');
        }
    }

    // Get repository info from payload
    const repoFullName = req.body.repository?.full_name;
    const branch = req.body.ref?.replace('refs/heads/', '');
    
    if (!repoFullName) {
        return res.status(400).send('Missing repository information');
    }

    console.log(`Push to ${repoFullName} on branch ${branch}`);

    // Load sites config
    let config;
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
        console.error('Failed to load config:', err);
        return res.status(500).send('Config error');
    }

    // Find matching site
    const site = config.sites.find(s => s.repo === repoFullName);
    if (!site) {
        console.log(`Ignored: unconfigured repo ${repoFullName}`);
        return res.status(200).send(`Ignored: unconfigured repo ${repoFullName}`);
    }

    // Check if push is to the configured branch
    if (branch !== site.branch) {
        console.log(`Ignored: push to ${branch}, expected ${site.branch}`);
        return res.status(200).send(`Ignored: not a push to ${site.branch}`);
    }

    try {
        const repoDir = path.join(REPOS_BASE, site.container_name);
        const cloneUrl = GITHUB_TOKEN 
            ? `https://x-access-token:${GITHUB_TOKEN}@github.com/${repoFullName}.git`
            : `https://github.com/${repoFullName}.git`;

        // Clone or pull repository
        if (!fs.existsSync(repoDir)) {
            console.log(`Cloning ${repoFullName}...`);
            execSync(`git clone ${cloneUrl} ${repoDir}`, { stdio: 'inherit' });
        } else {
            console.log(`Pulling latest changes for ${repoFullName}...`);
            execSync(`git -C ${repoDir} pull`, { stdio: 'inherit' });
        }

        // Build Docker image
        console.log(`Building image for ${site.container_name}...`);
        
        // Check if site has its own Dockerfile, otherwise use template
        const siteDockerfile = path.join(repoDir, 'Dockerfile');
        let buildCmd;
        
        if (fs.existsSync(siteDockerfile)) {
            console.log('Using site Dockerfile');
            buildCmd = `docker build -t ${site.container_name}:latest ${repoDir}`;
        } else {
            console.log('Using default template');
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
            console.log(`Stopping old container ${site.container_name}...`);
            execSync(`docker rm -f ${site.container_name}`, { stdio: 'inherit' });
        } catch (err) {
            // Container might not exist, that's fine
        }

        // Start new container
        console.log(`Starting new container ${site.container_name} on port ${site.port}...`);
        const runCmd = `docker run -d \
            --name ${site.container_name} \
            --network ${DOCKER_NETWORK} \
            --restart unless-stopped \
            -p ${site.port}:3000 \
            ${site.container_name}:latest`;
        
        execSync(runCmd, { stdio: 'inherit' });

        console.log(`Successfully deployed ${site.container_name}`);
        res.status(200).send(`Deployed ${site.container_name} successfully`);
    } catch (err) {
        console.error('Deployment error:', err);
        res.status(500).send(`Error: ${err.message}`);
    }
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

app.listen(PORT, HOST, () => {
    console.log(`Webhook server running on ${HOST}:${PORT}`);
    console.log(`Docker network: ${DOCKER_NETWORK}`);
    console.log(`Repos base: ${REPOS_BASE}`);
});

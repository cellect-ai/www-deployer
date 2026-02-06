#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Load .env
if [ ! -f .env ]; then
    echo "Error: .env file not found"
    exit 1
fi

source .env

# Get GitHub token from git credentials
GITHUB_TOKEN=$(grep github.com ~/.git-credentials 2>/dev/null | sed 's/.*://' | sed 's/@.*//' | head -1)
if [ -z "$GITHUB_TOKEN" ]; then
    echo "Error: GitHub token not found in ~/.git-credentials"
    exit 1
fi

# Get webhook secret from Infisical
echo "Getting webhook secret from Infisical..."
export INFISICAL_TOKEN=$(infisical login --method=universal-auth \
    --client-id=$INFISICAL_CLIENT_ID \
    --client-secret=$INFISICAL_CLIENT_SECRET \
    --silent --plain \
    --domain=$INFISICAL_API_URL)

WEBHOOK_SECRET=$(infisical export --projectId $INFISICAL_WORKSPACE_ID \
    --domain $INFISICAL_API_URL \
    --env $INFISICAL_ENV 2>/dev/null | grep WWW_GIT_DEPLOY_SECRET | cut -d'=' -f2 | tr -d "'")

if [ -z "$WEBHOOK_SECRET" ]; then
    echo "Error: WWW_GIT_DEPLOY_SECRET not found in Infisical"
    exit 1
fi

WEBHOOK_URL="https://ops.cellect.ai/git_www/hooks"

# Read sites from sites.json
SITES=$(jq -r '.sites[] | @base64' sites.json)

check_webhook() {
    local repo=$1
    echo "Checking webhook for $repo..."
    
    local hooks=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
        "https://api.github.com/repos/$repo/hooks")
    
    local hook_exists=$(echo "$hooks" | jq -r --arg url "$WEBHOOK_URL" \
        '.[] | select(.config.url == $url) | .id')
    
    if [ -n "$hook_exists" ]; then
        echo "  ✓ Webhook already configured (ID: $hook_exists)"
        return 0
    else
        echo "  ✗ Webhook not configured"
        return 1
    fi
}

configure_webhook() {
    local repo=$1
    echo "Configuring webhook for $repo..."
    
    local response=$(curl -s -X POST \
        -H "Authorization: token $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github.v3+json" \
        "https://api.github.com/repos/$repo/hooks" \
        -d '{
            "name": "web",
            "active": true,
            "events": ["push"],
            "config": {
                "url": "'"$WEBHOOK_URL"'",
                "content_type": "json",
                "secret": "'"$WEBHOOK_SECRET"'",
                "insecure_ssl": "0"
            }
        }')
    
    local hook_id=$(echo "$response" | jq -r '.id')
    
    if [ "$hook_id" != "null" ] && [ -n "$hook_id" ]; then
        echo "  ✓ Webhook configured successfully (ID: $hook_id)"
        return 0
    else
        local error=$(echo "$response" | jq -r '.message')
        echo "  ✗ Failed to configure webhook: $error"
        return 1
    fi
}

manual_deploy() {
    local repo=$1
    local container_name=$2
    
    echo "Manually triggering deployment for $repo..."
    
    # Create payload
    local payload='{"ref":"refs/heads/main","repository":{"full_name":"'$repo'"}}'
    
    # Calculate HMAC signature
    local signature="sha256=$(echo -n "$payload" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | cut -d' ' -f2)"
    
    # Trigger webhook locally
    local response=$(curl -s -X POST http://localhost:9009/hooks \
        -H "Content-Type: application/json" \
        -H "X-Hub-Signature-256: $signature" \
        -d "$payload")
    
    echo "$response"
    
    if echo "$response" | grep -q "Deployed\|successfully"; then
        echo "  ✓ Deployment triggered successfully"
        echo ""
        echo "Check logs: docker logs -f $container_name"
        return 0
    else
        echo "  ✗ Deployment failed"
        echo ""
        echo "Check deployer logs: docker logs www-deployer"
        return 1
    fi
}

# Main menu
show_menu() {
    echo ""
    echo "=== www-deployer Management ==="
    echo ""
    echo "Sites:"
    local i=1
    for site in $SITES; do
        local repo=$(echo "$site" | base64 -d | jq -r '.repo')
        local container=$(echo "$site" | base64 -d | jq -r '.container_name')
        echo "  $i) $repo ($container)"
        i=$((i+1))
    done
    echo ""
    echo "Actions:"
    echo "  w) Check and configure all webhooks"
    echo "  d) Manually deploy a site"
    echo "  q) Quit"
    echo ""
}

# Check all webhooks
check_all_webhooks() {
    echo ""
    echo "=== Checking Webhooks ==="
    echo ""
    
    local needs_config=()
    
    for site in $SITES; do
        local repo=$(echo "$site" | base64 -d | jq -r '.repo')
        
        if ! check_webhook "$repo"; then
            needs_config+=("$repo")
        fi
    done
    
    if [ ${#needs_config[@]} -eq 0 ]; then
        echo ""
        echo "All webhooks are configured!"
        return 0
    fi
    
    echo ""
    echo "Found ${#needs_config[@]} site(s) needing webhook configuration."
    read -p "Configure them now? (y/n) " -n 1 -r
    echo
    
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        for repo in "${needs_config[@]}"; do
            configure_webhook "$repo"
        done
    fi
}

# Manual deploy menu
deploy_menu() {
    echo ""
    echo "=== Manual Deploy ==="
    echo ""
    
    local i=1
    local repos=()
    local containers=()
    
    for site in $SITES; do
        local repo=$(echo "$site" | base64 -d | jq -r '.repo')
        local container=$(echo "$site" | base64 -d | jq -r '.container_name')
        echo "  $i) $repo"
        repos+=("$repo")
        containers+=("$container")
        i=$((i+1))
    done
    
    echo "  0) Back"
    echo ""
    read -p "Select site to deploy: " choice
    
    if [ "$choice" == "0" ]; then
        return
    fi
    
    local idx=$((choice-1))
    if [ $idx -ge 0 ] && [ $idx -lt ${#repos[@]} ]; then
        manual_deploy "${repos[$idx]}" "${containers[$idx]}"
    else
        echo "Invalid selection"
    fi
}

# Interactive mode
if [ "$1" == "" ]; then
    while true; do
        show_menu
        read -p "Select action: " action
        
        case $action in
            w)
                check_all_webhooks
                ;;
            d)
                deploy_menu
                ;;
            q)
                echo "Goodbye!"
                exit 0
                ;;
            *)
                echo "Invalid option"
                ;;
        esac
    done
fi

# CLI mode
case "$1" in
    check)
        check_all_webhooks
        ;;
    configure)
        check_all_webhooks
        ;;
    deploy)
        if [ -z "$2" ]; then
            echo "Usage: $0 deploy <repo-name>"
            echo "Example: $0 deploy cellect-ai/www-v0"
            exit 1
        fi
        
        FOUND=0
        for site in $SITES; do
            REPO=$(echo "$site" | base64 -d | jq -r '.repo')
            CONTAINER=$(echo "$site" | base64 -d | jq -r '.container_name')
            
            if [ "$REPO" == "$2" ]; then
                manual_deploy "$REPO" "$CONTAINER"
                FOUND=1
                exit 0
            fi
        done
        
        if [ $FOUND -eq 0 ]; then
            echo "Error: Site '$2' not found in sites.json"
            exit 1
        fi
        ;;
    *)
        echo "Usage: $0 [check|configure|deploy <repo>]"
        echo ""
        echo "Commands:"
        echo "  check      - Check webhook configuration for all sites"
        echo "  configure  - Check and configure webhooks for all sites"
        echo "  deploy     - Manually deploy a site"
        echo ""
        echo "Run without arguments for interactive mode"
        exit 1
        ;;
esac

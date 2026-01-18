#!/bin/bash
# WebSync Remote Deployment Script
# 
# Usage: 
#   curl -sSL https://raw.githubusercontent.com/YOUR_USERNAME/websync/main/deploy.sh | bash -s -- your-dockerhub-username
#
# Or download and run:
#   ./deploy.sh your-dockerhub-username

set -e

DOCKER_HUB_USER="${1:-}"
INSTALL_DIR="${2:-/mnt/user/appdata/websync}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       WebSync Deployment Script        ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""

# Check for Docker Hub username
if [ -z "$DOCKER_HUB_USER" ]; then
    echo -e "${RED}Error: Docker Hub username required${NC}"
    echo "Usage: $0 <dockerhub-username> [install-directory]"
    exit 1
fi

echo -e "${YELLOW}Docker Hub Image:${NC} $DOCKER_HUB_USER/websync:latest"
echo -e "${YELLOW}Install Directory:${NC} $INSTALL_DIR"
echo ""

# Create install directory
echo -e "${GREEN}Creating install directory...${NC}"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Create docker-compose.yml
echo -e "${GREEN}Creating docker-compose.yml...${NC}"
cat > docker-compose.yml << COMPOSE
version: '3.8'

services:
  websync:
    image: ${DOCKER_HUB_USER}/websync:latest
    container_name: websync
    restart: unless-stopped
    ports:
      - "\${WEBSYNC_PORT:-3000}:3000"
    environment:
      - AUTH_PASSWORD=\${AUTH_PASSWORD:?AUTH_PASSWORD is required}
      - JWT_SECRET=\${JWT_SECRET:?JWT_SECRET is required}
      - DATABASE_URL=file:/data/websync.db
      - NODE_ENV=production
    volumes:
      - websync-data:/data
      - /var/run/docker.sock:/var/run/docker.sock
      - \${SSH_KEY_PATH:-/root/.ssh}:/root/.ssh:ro
      - /mnt/user/appdata:/mnt/user/appdata
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s

volumes:
  websync-data:
    name: websync-data
COMPOSE

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo -e "${GREEN}Creating .env file...${NC}"
    JWT_SECRET=$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)
    cat > .env << ENV
# WebSync Configuration
DOCKER_HUB_IMAGE=${DOCKER_HUB_USER}/websync
WEBSYNC_PORT=3000
SSH_KEY_PATH=/root/.ssh

# Authentication - CHANGE THE PASSWORD!
AUTH_PASSWORD=changeme
JWT_SECRET=${JWT_SECRET}
ENV
    echo -e "${YELLOW}⚠️  Remember to change AUTH_PASSWORD in .env!${NC}"
else
    echo -e "${YELLOW}Keeping existing .env file${NC}"
fi

# Pull and start
echo ""
echo -e "${GREEN}Pulling latest image...${NC}"
docker compose pull

echo ""
echo -e "${GREEN}Starting WebSync...${NC}"
docker compose up -d

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Deployment Complete!           ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "WebSync is running at: ${YELLOW}http://$(hostname -I | awk '{print $1}'):3000${NC}"
echo ""
echo "Commands:"
echo "  cd $INSTALL_DIR"
echo "  docker compose logs -f    # View logs"
echo "  docker compose restart    # Restart"
echo "  docker compose down       # Stop"
echo "  docker compose pull && docker compose up -d  # Update"
echo ""
echo -e "${YELLOW}Don't forget to edit .env and change AUTH_PASSWORD!${NC}"

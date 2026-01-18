# WebSync Deployment Guide

This guide will help you deploy WebSync on your Unraid servers for bidirectional site synchronization.

## Prerequisites

- Two Unraid servers (primary and secondary)
- SSH key-based authentication set up between servers
- Docker and Docker Compose installed
- Network connectivity between servers on port 3000 (or your configured port)

---

## Quick Start

### 1. Clone or Copy to Both Servers

Copy the WebSync folder to both Unraid servers:

```bash
# On each server
cd /mnt/user/appdata
git clone <your-repo-url> websync
# OR
# Copy the websync folder via your preferred method
```

### 2. Configure Environment

```bash
cd /mnt/user/appdata/websync

# Copy the example environment file
cp .env.example .env

# Edit with your settings
nano .env
```

**Important:** Set secure values for:
- `AUTH_PASSWORD` - Your login password
- `JWT_SECRET` - A random secret (generate with `openssl rand -base64 32`)

### 3. Set Up SSH Keys

WebSync uses SSH for secure file sync between servers. Ensure passwordless SSH access:

```bash
# On primary server, generate SSH key if needed
ssh-keygen -t ed25519 -C "websync"

# Copy to secondary server
ssh-copy-id root@<secondary-server-ip>

# Test connection
ssh root@<secondary-server-ip> "echo 'SSH works!'"
```

### 4. Build and Deploy

```bash
# Build the Docker image
docker compose build

# Start WebSync
docker compose up -d

# Check logs
docker compose logs -f websync
```

### 5. Access WebSync

Open your browser and navigate to:
```
http://<server-ip>:3000
```

Log in with the password you set in `.env`.

---

## Configuration

### docker-compose.yml Volume Mounts

Customize the volume mounts for your Unraid setup:

```yaml
volumes:
  # Database persistence
  - websync-data:/data
  
  # Docker socket for local container management
  - /var/run/docker.sock:/var/run/docker.sock
  
  # SSH keys
  - /root/.ssh:/root/.ssh:ro
  
  # Your app data (modify as needed)
  - /mnt/user/appdata:/mnt/user/appdata
```

### Initial Settings

After first login, go to **Settings** and configure:

1. **Server Identity**
   - Server Name: A friendly name (e.g., "Primary Unraid")
   - Server Role: primary, secondary, or peer

2. **Remote SSH Connection**
   - Remote Host: `root@192.168.1.xxx` (your other server)
   - SSH Port: 22 (default)
   - SSH Key Path: `/root/.ssh/id_ed25519` (or your key path)

3. **Remote WebSync API** (for health checks)
   - Remote API URL: `http://192.168.1.xxx:3000`
   - Remote API Token: (optional, uses AUTH_PASSWORD if blank)

4. **Sync Configuration**
   - Sync Direction: push, pull, or bidirectional
   - Only sync when healthy: Recommended for reliability

---

## Deploying on Both Servers

For bidirectional sync, deploy WebSync on BOTH servers:

### Primary Server
```bash
# In .env
AUTH_PASSWORD=your-shared-password
```

In Settings:
- Server Role: Primary
- Remote Host: root@<secondary-ip>
- Sync Direction: Push (or Bidirectional)

### Secondary Server
```bash
# In .env (use same password for API communication)
AUTH_PASSWORD=your-shared-password
```

In Settings:
- Server Role: Secondary  
- Remote Host: root@<primary-ip>
- Sync Direction: Pull (or Bidirectional)

---

## Adding Sites

1. Click **Add Site** on the Dashboard
2. Fill in:
   - **Label**: Friendly name (e.g., "My WordPress Site")
   - **Local Path**: `/mnt/user/appdata/wordpress`
   - **Remote Path**: `/mnt/user/appdata/wordpress`
   - **Schedule**: Choose preset or custom cron
   
3. Optional settings:
   - **Editor URL**: Link to your VSCodium/code-server
   - **Site URL**: Link to the live website
   - **Database sync**: For MySQL/PostgreSQL containers
   - **Remote containers**: Docker containers to manage on remote

---

## Unraid Community Applications

To create an Unraid template, create an XML file at:
```
/boot/config/plugins/dockerMan/templates-user/my-websync.xml
```

Example template:

```xml
<?xml version="1.0"?>
<Container version="2">
  <Name>WebSync</Name>
  <Repository>websync:latest</Repository>
  <Network>bridge</Network>
  <Privileged>false</Privileged>
  <Support/>
  <Overview>Sync files and databases between Unraid servers</Overview>
  <Category>Tools: Backup:</Category>
  <WebUI>http://[IP]:[PORT:3000]/</WebUI>
  <TemplateURL/>
  <Icon>https://raw.githubusercontent.com/your-repo/websync/main/icon.png</Icon>
  <Config Name="Web UI Port" Target="3000" Default="3000" Mode="tcp" Description="WebSync web interface port" Type="Port" Display="always" Required="true">3000</Config>
  <Config Name="Password" Target="AUTH_PASSWORD" Default="changeme" Description="Login password" Type="Variable" Display="always" Required="true">changeme</Config>
  <Config Name="JWT Secret" Target="JWT_SECRET" Default="" Description="JWT secret for sessions" Type="Variable" Display="always" Required="true"/>
  <Config Name="Appdata" Target="/mnt/user/appdata" Default="/mnt/user/appdata" Mode="rw" Description="Path to appdata" Type="Path" Display="always" Required="true">/mnt/user/appdata</Config>
  <Config Name="SSH Keys" Target="/root/.ssh" Default="/root/.ssh" Mode="ro" Description="SSH keys for rsync" Type="Path" Display="always" Required="true">/root/.ssh</Config>
  <Config Name="Data" Target="/data" Default="" Mode="rw" Description="WebSync database" Type="Path" Display="always" Required="true">/mnt/user/appdata/websync/data</Config>
  <Config Name="Docker Socket" Target="/var/run/docker.sock" Default="/var/run/docker.sock" Mode="rw" Description="Docker socket for container management" Type="Path" Display="advanced" Required="false">/var/run/docker.sock</Config>
</Container>
```

---

## Troubleshooting

### Check Container Logs
```bash
docker compose logs -f websync
```

### Test SSH Connection
Use the "Test SSH Connection" button in Settings, or manually:
```bash
docker exec -it websync ssh root@<remote-ip> "echo OK"
```

### Database Issues
```bash
# Reset database
docker compose down
docker volume rm websync-data
docker compose up -d
```

### Permission Issues
Ensure the container can access mounted volumes:
```bash
# Check mounts
docker exec -it websync ls -la /mnt/user/appdata
```

### Health Check Failing
```bash
# Check if the app is running
docker exec -it websync wget -qO- http://localhost:3000/health
```

---

## Updating

```bash
cd /mnt/user/appdata/websync

# Pull latest changes
git pull

# Rebuild and restart
docker compose build
docker compose up -d
```

---

## Security Notes

1. **Change default passwords** - Never use default AUTH_PASSWORD in production
2. **Use strong JWT secrets** - Generate with `openssl rand -base64 32`
3. **Firewall** - Only expose port 3000 to trusted networks
4. **SSH keys** - Use Ed25519 keys with no passphrase (or ssh-agent)
5. **HTTPS** - Consider putting WebSync behind a reverse proxy (Nginx/Traefik) with SSL

---

## Support

For issues and feature requests, please open an issue on the GitHub repository.

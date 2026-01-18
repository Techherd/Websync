# WebSync Self-Hosted

A self-hosted website synchronization tool for Unraid and Docker environments. Sync files and databases between servers with real-time progress tracking, scheduled syncs, and bidirectional communication.

![WebSync Dashboard](https://img.shields.io/badge/WebSync-Self--Hosted-00b4d8?style=for-the-badge)

## Features

- 🔄 **File Synchronization** — Sync website files between servers using rsync
- 🗄️ **Database Sync** — Dump and restore MySQL/MariaDB/PostgreSQL databases
- ⏰ **Scheduled Syncs** — Automatic syncs on hourly, 6-hour, 12-hour, or custom schedules
- 🔐 **SSH Key Authentication** — Secure passwordless connections between servers
- 📡 **Real-time Progress** — WebSocket-based live sync progress updates
- 🏥 **Health Monitoring** — Automatic health checks between paired servers
- 🐳 **Remote Container Management** — Start/stop/restart containers on remote server
- 📥 **Remote Database Import** — Automatically import database dumps on the receiving server
- 🎨 **WordPress Support** — Generate temporary admin credentials for WordPress sites
- 📊 **Received Sites View** — Secondary server shows read-only list of synced sites

---

## Quick Start

### Option 1: Docker Hub (Recommended)

```bash
docker run -d \
  --name websync \
  -p 3000:3000 \
  -v /mnt/user/appdata/websync:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /root/.ssh:/root/.ssh:ro \
  -e AUTH_PASSWORD=your-secure-password \
  -e JWT_SECRET=your-random-secret \
  althe3rd/websync:latest
```

### Option 2: Unraid Docker Template

1. Copy `unraid-template.xml` to `/boot/config/plugins/dockerMan/templates-user/websync.xml`
2. Go to Docker → Add Container → Select "websync" template
3. Configure the variables and paths
4. Start the container

### Option 3: Docker Compose

```bash
# Clone the repository
git clone https://github.com/althe3rd/websync-self-hosted.git
cd websync-self-hosted

# Create .env file
cp env.example .env
# Edit .env with your settings

# Start
docker-compose up -d
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTH_PASSWORD` | Password to login to the web UI | `admin` |
| `JWT_SECRET` | Secret for session tokens (use a random string) | `websync-dev-secret` |
| `DATABASE_URL` | SQLite database path | `file:/data/websync.db` |
| `NODE_ENV` | Set to `production` for production use | `production` |

---

## Volume Mounts

| Container Path | Description |
|----------------|-------------|
| `/data` | Persistent storage for SQLite database |
| `/var/run/docker.sock` | Docker socket for container management |
| `/root/.ssh` | SSH keys for remote server access (mount as `:ro` for read-only) |
| `/mnt/user/appdata/websites` | Your website files (adjust path as needed) |

---

## Setting Up Two-Server Sync

This guide walks through setting up WebSync on two servers (Primary and Secondary) for bidirectional sync.

### Architecture Overview

```
┌─────────────────────┐         SSH/rsync          ┌─────────────────────┐
│   PRIMARY SERVER    │ ◄─────────────────────────► │  SECONDARY SERVER   │
│   192.168.1.100     │         HTTP API           │   192.168.1.200     │
│                     │ ◄─────────────────────────► │                     │
│   WebSync :3000     │                            │   WebSync :3000     │
└─────────────────────┘                            └─────────────────────┘
```

### Step 1: Install WebSync on Both Servers

Run the docker command (or use Unraid template) on **both** servers:

```bash
# On PRIMARY (192.168.1.100)
docker run -d \
  --name websync \
  -p 3000:3000 \
  -v /mnt/user/appdata/websync:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /root/.ssh:/root/.ssh \
  -v /mnt/user/appdata/websites:/mnt/user/appdata/websites \
  -e AUTH_PASSWORD=your-password \
  -e JWT_SECRET=primary-secret-123 \
  althe3rd/websync:latest

# On SECONDARY (192.168.1.200) - same command
docker run -d \
  --name websync \
  -p 3000:3000 \
  -v /mnt/user/appdata/websync:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /root/.ssh:/root/.ssh \
  -v /mnt/user/appdata/websites:/mnt/user/appdata/websites \
  -e AUTH_PASSWORD=your-password \
  -e JWT_SECRET=secondary-secret-456 \
  althe3rd/websync:latest
```

### Step 2: Generate SSH Keys

SSH keys allow passwordless, secure connections between servers.

#### On the PRIMARY server:

```bash
# Generate a new SSH key pair
ssh-keygen -t ed25519 -f /root/.ssh/websync_key -N ""

# Copy the public key to the SECONDARY server
ssh-copy-id -i /root/.ssh/websync_key.pub root@192.168.1.200

# Test the connection (should connect without password prompt)
ssh -i /root/.ssh/websync_key root@192.168.1.200 "echo 'Connection successful!'"
```

#### On the SECONDARY server (for bidirectional sync):

```bash
# Generate a new SSH key pair
ssh-keygen -t ed25519 -f /root/.ssh/websync_key -N ""

# Copy the public key to the PRIMARY server
ssh-copy-id -i /root/.ssh/websync_key.pub root@192.168.1.100

# Test the connection
ssh -i /root/.ssh/websync_key root@192.168.1.100 "echo 'Connection successful!'"
```

### Step 3: Configure WebSync Settings

#### On PRIMARY (http://192.168.1.100:3000):

1. Go to **Settings**
2. Fill in:
   - **Server Name**: `Primary`
   - **Server Role**: `Primary (source server)`
   - **Remote Host**: `root@192.168.1.200`
   - **SSH Port**: `22`
   - **SSH Key Path**: `/root/.ssh/websync_key`
   - **Remote API URL**: `http://192.168.1.200:3000`
3. Click **Generate** to create a Shared API Token
4. **Copy the token** — you'll need it for the secondary
5. Click **Save Settings**
6. Click **Test SSH** to verify connection

#### On SECONDARY (http://192.168.1.200:3000):

1. Go to **Settings**
2. Fill in:
   - **Server Name**: `Secondary`
   - **Server Role**: `Secondary (backup server)`
   - **Remote Host**: `root@192.168.1.100`
   - **SSH Port**: `22`
   - **SSH Key Path**: `/root/.ssh/websync_key`
   - **Remote API URL**: `http://192.168.1.100:3000`
   - **Shared API Token**: **Paste the token from PRIMARY**
3. Click **Save Settings**
4. Click **Test SSH** to verify connection

### Step 4: Verify Health Checks

After configuration, both dashboards should show:
- **"Remote Online"** status bar (green)
- Health checks running every 30 seconds

If you see "Remote Offline":
1. Check if both containers are running
2. Verify the Remote API URL is correct
3. Ensure port 3000 is accessible between servers
4. Verify the Shared API Token matches on both servers

---

## Adding Sites to Sync

### On the PRIMARY server:

1. Click **+ Add Site**
2. Fill in:
   - **Label**: Human-readable name (e.g., "My WordPress Site")
   - **Local Path**: Path on PRIMARY (e.g., `/mnt/user/appdata/websites/mysite`)
   - **Remote Path**: Path on SECONDARY (usually the same path)
   - **Site Type**: WordPress, Laravel, Node.js, Static, or Custom
   - **Sync Schedule**: Manual, Every Hour, Every 6 Hours, etc.

3. Optional — **Database Sync**:
   - **DB Container**: Your database container name (e.g., `mysite-mariadb`)
   - **DB Type**: MySQL/MariaDB or PostgreSQL
   - **DB User/Password/Name**: Database credentials

4. Optional — **Remote Database Import**:
   - **Remote DB Container**: Database container on SECONDARY
   - **Remote DB User/Password/Name**: Credentials on SECONDARY
   
5. Click **Save**

### Triggering a Sync

- Click the **Push** button on a site card
- Or wait for the scheduled sync to run

After sync completes, the SECONDARY dashboard will show the site in the **"Received Sites"** section (read-only).

---

## Database Sync Details

### How It Works

1. **Dump**: WebSync runs `mariadb-dump` or `mysqldump` inside your database container
2. **Transfer**: The dump file is rsync'd to the remote server's `<remotePath>/dumps/` folder
3. **Import**: WebSync runs the import command inside the remote database container

### Requirements

- Database container must be running
- For MariaDB: Container needs `mariadb-dump` (included in official images)
- For MySQL: Container needs `mysqldump`
- For PostgreSQL: Container needs `pg_dump` and `psql`

### Troubleshooting Database Sync

Check logs for errors:
```bash
docker logs websync 2>&1 | grep "DB DUMP\|DB IMPORT"
```

Common issues:
- `mysqldump: not found` → Use MariaDB image or install mysql-client
- `Access denied` → Check database credentials
- Empty dump file → Database connection failed

---

## Remote Container Management

WebSync can start/stop/restart Docker containers on the remote server after sync.

### Setup

1. Edit a site
2. Under **Remote Container Management**:
   - **Remote Containers**: Comma-separated container names (e.g., `nginx,php-fpm`)
   - **Auto-start after sync**: Enable to automatically start containers after successful sync

### Manual Control

Click the play/stop/restart icons on the site card to control remote containers.

---

## WordPress Integration

### Site Type

Set **Site Type** to "WordPress" to enable:
- WordPress icon on site cards
- WP-CLI admin generation

### Temporary Admin Access

1. Click the **user icon** on a WordPress site card
2. WebSync creates a temporary admin user via WP-CLI
3. Credentials expire in 24 hours

**Requirements**:
- WordPress container must have WP-CLI installed
- Set **WP Container** and **WP Path** in site settings

---

## Scheduled Syncs

### Preset Schedules

| Option | Cron Expression | Description |
|--------|-----------------|-------------|
| Manual | (none) | Only sync when button is clicked |
| Every Hour | `0 * * * *` | Run at minute 0 of every hour |
| Every 6 Hours | `0 */6 * * *` | Run at 00:00, 06:00, 12:00, 18:00 |
| Every 12 Hours | `0 */12 * * *` | Run at 00:00 and 12:00 |
| Every 24 Hours | `0 0 * * *` | Run at midnight |
| Custom | (your cron) | Any valid cron expression |

### Checking Scheduled Jobs

```bash
docker logs websync 2>&1 | grep "SCHEDULER"
```

You should see:
```
[SCHEDULER] Starting scheduler...
[SCHEDULER] Found 3 sites with schedules
[SCHEDULER] Scheduling site "My Site" with cron: 0 */6 * * *
[SCHEDULER] Task registered for "My Site"
```

---

## Troubleshooting

### Container won't start

```bash
docker logs websync
```

Look for:
- Database migration errors
- Port binding issues
- Volume mount problems

### SSH connection fails

```bash
# Test SSH manually from inside the container
docker exec -it websync ssh -i /root/.ssh/websync_key root@192.168.1.200

# Check if key is readable
docker exec -it websync ls -la /root/.ssh/
```

Common issues:
- Key permissions too open: `chmod 600 /root/.ssh/websync_key`
- Key not copied to remote: Run `ssh-copy-id` again
- Wrong key path in settings

### Syncs not running on schedule

1. Check if scheduler is active:
   ```bash
   docker logs websync 2>&1 | grep "SCHEDULER"
   ```

2. Check if syncs are being skipped:
   ```bash
   docker logs websync 2>&1 | grep "Skipping"
   ```

3. Verify container hasn't restarted:
   ```bash
   docker inspect websync --format '{{.State.StartedAt}}'
   ```

### Database dump is empty

```bash
docker logs websync 2>&1 | grep "DB DUMP"
```

Check:
- Database container is running
- Credentials are correct
- `mariadb-dump` or `mysqldump` is available in container

### Health check failing

1. Verify Remote API URL is correct
2. Check if port 3000 is open between servers
3. Verify Shared API Token matches exactly on both servers

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check (public) |
| `/auth/login` | POST | Login with password |
| `/sites` | GET/POST | List/create sites |
| `/sites/:id` | GET/PUT/DELETE | Get/update/delete site |
| `/sites/:id/sync` | POST | Trigger sync |
| `/jobs` | GET | List sync jobs |
| `/settings` | GET/PUT | Get/update settings |
| `/received-sites` | GET | List sites synced TO this server |

---

## Development

### Prerequisites

- Node.js 20+
- npm 9+

### Setup

```bash
# Install dependencies
npm install

# Start development servers
npm run dev
```

This starts:
- Backend: http://localhost:3000
- Frontend: http://localhost:5173 (proxied to backend)

### Building

```bash
# Build for production
npm run build

# Build Docker image
npm run docker:build

# Build for AMD64 (for Unraid on x86)
npm run docker:build:amd64
```

---

## License

MIT License - See LICENSE file for details.

---

## Credits

Built with:
- [Fastify](https://fastify.io/) — Fast Node.js web framework
- [Vue 3](https://vuejs.org/) — Frontend framework
- [Prisma](https://prisma.io/) — Database ORM
- [node-cron](https://github.com/node-cron/node-cron) — Task scheduling

---

**Powered by Techherd** 🦬

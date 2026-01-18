import { spawn } from 'child_process';
import prisma from './prisma';

interface SSHCommandResult {
    success: boolean;
    output: string;
    error?: string;
    exitCode: number;
}

/**
 * Execute a command on the remote server via SSH
 */
export const executeRemoteCommand = async (command: string): Promise<SSHCommandResult> => {
    const settings = await prisma.settings.findUnique({
        where: { id: 'default' }
    });

    if (!settings?.remoteHost) {
        return {
            success: false,
            output: '',
            error: 'Remote host not configured',
            exitCode: -1
        };
    }

    return new Promise((resolve) => {
        const args = [
            '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=10',
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',  // Don't try to write known_hosts (for read-only mounts)
            '-o', 'LogLevel=ERROR',  // Suppress warnings like "Permanently added to known hosts"
            '-p', String(settings.remotePort || 22)
        ];

        if (settings.sshKeyPath) {
            args.push('-i', settings.sshKeyPath);
        }

        args.push(settings.remoteHost, command);

        const proc = spawn('ssh', args);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            resolve({
                success: code === 0,
                output: stdout.trim(),
                error: stderr.trim() || undefined,
                exitCode: code || 0
            });
        });

        proc.on('error', (err) => {
            resolve({
                success: false,
                output: '',
                error: err.message,
                exitCode: -1
            });
        });

        // Timeout after 30 seconds
        setTimeout(() => {
            proc.kill();
            resolve({
                success: false,
                output: stdout.trim(),
                error: 'Command timeout',
                exitCode: -1
            });
        }, 30000);
    });
};

/**
 * Get status of containers on remote server
 */
export const getRemoteContainerStatus = async (containerNames: string[]): Promise<{
    containers: Array<{
        name: string;
        running: boolean;
        status: string;
        error?: string;
    }>;
}> => {
    const containers = [];

    for (const name of containerNames) {
        const result = await executeRemoteCommand(
            `docker inspect --format='{{.State.Status}}' ${name} 2>/dev/null || echo 'not_found'`
        );

        if (result.success) {
            const status = result.output.trim();
            containers.push({
                name,
                running: status === 'running',
                status: status === 'not_found' ? 'not found' : status
            });
        } else {
            containers.push({
                name,
                running: false,
                status: 'unknown',
                error: result.error
            });
        }
    }

    return { containers };
};

/**
 * Start containers on remote server
 */
export const startRemoteContainers = async (containerNames: string[]): Promise<{
    success: boolean;
    results: Array<{
        name: string;
        started: boolean;
        message: string;
    }>;
}> => {
    const results = [];
    let allSuccess = true;

    for (const name of containerNames) {
        const result = await executeRemoteCommand(`docker start ${name}`);

        if (result.success) {
            results.push({
                name,
                started: true,
                message: `Container ${name} started successfully`
            });
        } else {
            allSuccess = false;
            results.push({
                name,
                started: false,
                message: result.error || `Failed to start ${name}`
            });
        }
    }

    return { success: allSuccess, results };
};

/**
 * Stop containers on remote server
 */
export const stopRemoteContainers = async (containerNames: string[]): Promise<{
    success: boolean;
    results: Array<{
        name: string;
        stopped: boolean;
        message: string;
    }>;
}> => {
    const results = [];
    let allSuccess = true;

    for (const name of containerNames) {
        const result = await executeRemoteCommand(`docker stop ${name}`);

        if (result.success) {
            results.push({
                name,
                stopped: true,
                message: `Container ${name} stopped successfully`
            });
        } else {
            allSuccess = false;
            results.push({
                name,
                stopped: false,
                message: result.error || `Failed to stop ${name}`
            });
        }
    }

    return { success: allSuccess, results };
};

/**
 * Restart containers on remote server
 */
export const restartRemoteContainers = async (containerNames: string[]): Promise<{
    success: boolean;
    results: Array<{
        name: string;
        restarted: boolean;
        message: string;
    }>;
}> => {
    const results = [];
    let allSuccess = true;

    for (const name of containerNames) {
        const result = await executeRemoteCommand(`docker restart ${name}`);

        if (result.success) {
            results.push({
                name,
                restarted: true,
                message: `Container ${name} restarted successfully`
            });
        } else {
            allSuccess = false;
            results.push({
                name,
                restarted: false,
                message: result.error || `Failed to restart ${name}`
            });
        }
    }

    return { success: allSuccess, results };
};

/**
 * Import database dump on remote server
 */
export const importRemoteDatabase = async (
    containerName: string,
    dbType: 'mysql' | 'postgres',
    dbUser: string,
    dbPassword: string,
    dbName: string,
    dumpPath: string
): Promise<SSHCommandResult> => {
    console.log('[DB IMPORT] Starting remote database import');
    console.log('[DB IMPORT] Container:', containerName);
    console.log('[DB IMPORT] DB Type:', dbType);
    console.log('[DB IMPORT] DB Name:', dbName);
    console.log('[DB IMPORT] Dump Path:', dumpPath);

    // First, find the actual dump file (resolve glob pattern)
    const findCmd = `ls -t ${dumpPath} 2>/dev/null | head -1`;
    console.log('[DB IMPORT] Finding dump file:', findCmd);
    
    const findResult = await executeRemoteCommand(findCmd);
    
    if (!findResult.success || !findResult.output.trim()) {
        console.error('[DB IMPORT] No dump file found at:', dumpPath);
        return {
            success: false,
            output: '',
            error: `No dump file found at ${dumpPath}`,
            exitCode: 1
        };
    }

    const actualDumpFile = findResult.output.trim();
    console.log('[DB IMPORT] Found dump file:', actualDumpFile);

    // Use cat to pipe the file content into docker exec
    // This is more reliable than shell redirection over SSH
    let importCmd: string;

    if (dbType === 'mysql') {
        // MySQL/MariaDB import - try mariadb first, fall back to mysql
        // Use sh -c to handle the command detection inside the container
        importCmd = `cat "${actualDumpFile}" | docker exec -i ${containerName} sh -c 'command -v mariadb >/dev/null 2>&1 && mariadb -u${dbUser} -p${dbPassword} ${dbName} || mysql -u${dbUser} -p${dbPassword} ${dbName}'`;
    } else {
        // PostgreSQL import
        importCmd = `cat "${actualDumpFile}" | docker exec -i ${containerName} psql -U ${dbUser} -d ${dbName}`;
    }

    console.log('[DB IMPORT] Running import command...');
    const result = await executeRemoteCommand(importCmd);
    
    console.log('[DB IMPORT] Result:', {
        success: result.success,
        exitCode: result.exitCode,
        outputLength: result.output?.length || 0,
        error: result.error
    });

    if (result.success) {
        console.log('[DB IMPORT] Database import completed successfully');
    } else {
        console.error('[DB IMPORT] Database import failed:', result.error);
    }

    return result;
};

/**
 * List all containers on remote server
 */
export const listRemoteContainers = async (): Promise<{
    success: boolean;
    containers: Array<{
        name: string;
        image: string;
        status: string;
        running: boolean;
    }>;
    error?: string;
}> => {
    const result = await executeRemoteCommand(
        `docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}'`
    );

    if (!result.success) {
        return {
            success: false,
            containers: [],
            error: result.error
        };
    }

    const containers = result.output
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
            const [name, image, status, state] = line.split('|');
            return {
                name,
                image,
                status,
                running: state === 'running'
            };
        });

    return { success: true, containers };
};

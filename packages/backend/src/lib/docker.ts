import Docker from 'dockerode';
import crypto from 'crypto';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export const listContainers = async () => {
    return docker.listContainers({ all: true });
};

export const getContainerParams = async (containerName: string) => {
    const container = docker.getContainer(containerName);
    return container.inspect();
}

export const executeCommand = async (containerName: string, cmd: string[]): Promise<string> => {
    const container = docker.getContainer(containerName);

    const exec = await container.exec({
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise((resolve, reject) => {
        let output = '';
        
        stream.on('data', (chunk: Buffer) => {
            // Docker stream includes 8-byte header, skip it for cleaner output
            const data = chunk.slice(8).toString();
            output += data;
        });

        stream.on('end', () => {
            resolve(output.trim());
        });

        stream.on('error', (err: Error) => {
            reject(err);
        });
    });
};

/**
 * Generate a temporary WordPress admin user using WP-CLI
 * Checks for existing websync_admin_* users first and reuses/resets password if found
 */
export const generateWpAdmin = async (
    containerName: string,
    wpPath: string = '/var/www/html',
    expiresInHours: number = 24
): Promise<{
    success: boolean;
    username?: string;
    password?: string;
    expiresAt?: string;
    loginUrl?: string;
    error?: string;
    debug?: string;
    reused?: boolean;
}> => {
    const logs: string[] = [];
    
    try {
        logs.push(`Container: ${containerName}`);
        logs.push(`WP Path: ${wpPath}`);
        
        // Step 1: Check if WP-CLI is available in the container
        let wpCliPath = '';
        try {
            const whichResult = await executeCommand(containerName, ['sh', '-c', 'which wp 2>/dev/null || echo "not found"']);
            logs.push(`which wp: ${whichResult}`);
            
            if (whichResult && !whichResult.includes('not found')) {
                wpCliPath = whichResult.trim();
            }
        } catch (e: any) {
            logs.push(`which wp error: ${e.message}`);
        }
        
        // Step 2: Check common WP-CLI locations if not in PATH
        if (!wpCliPath) {
            const commonPaths = ['/usr/local/bin/wp', '/usr/bin/wp', `${wpPath}/wp-cli.phar`];
            for (const path of commonPaths) {
                try {
                    const checkResult = await executeCommand(containerName, ['sh', '-c', `test -f ${path} && echo "exists" || echo "not found"`]);
                    logs.push(`Check ${path}: ${checkResult}`);
                    if (checkResult.includes('exists')) {
                        wpCliPath = path;
                        break;
                    }
                } catch (e) {
                    // Continue checking
                }
            }
        }
        
        if (!wpCliPath) {
            logs.push('WP-CLI not found in container');
            return {
                success: false,
                error: 'WP-CLI not found in container. Please install WP-CLI in your WordPress container.',
                debug: logs.join('\n')
            };
        }
        
        logs.push(`Using WP-CLI at: ${wpCliPath}`);
        
        // Step 3: Verify WordPress is installed at the path
        const wpCheckCmd = `cd ${wpPath} && ${wpCliPath} core is-installed --allow-root 2>&1`;
        const wpCheckResult = await executeCommand(containerName, ['sh', '-c', wpCheckCmd]);
        logs.push(`WP check: ${wpCheckResult}`);
        
        if (wpCheckResult.toLowerCase().includes('error') || wpCheckResult.toLowerCase().includes('not installed')) {
            return {
                success: false,
                error: `WordPress not found at ${wpPath}. Check the WP Path setting.`,
                debug: logs.join('\n')
            };
        }
        
        // Step 4: Check for existing websync_admin_* user
        const listCmd = `cd ${wpPath} && ${wpCliPath} user list --field=user_login --allow-root 2>&1 | grep "^websync_admin_" | head -1`;
        const existingUser = await executeCommand(containerName, ['sh', '-c', listCmd]);
        logs.push(`Existing user check: "${existingUser.trim()}"`);
        
        let username: string;
        let password: string;
        let reused = false;
        
        if (existingUser && existingUser.trim().startsWith('websync_admin_')) {
            // Reuse existing user - just reset their password
            username = existingUser.trim();
            password = crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
            
            logs.push(`Found existing user: ${username}, resetting password`);
            
            const resetCmd = `cd ${wpPath} && ${wpCliPath} user update "${username}" --user_pass="${password}" --allow-root 2>&1`;
            const resetResult = await executeCommand(containerName, ['sh', '-c', resetCmd]);
            logs.push(`Password reset result: ${resetResult}`);
            
            if (resetResult.toLowerCase().includes('error')) {
                return {
                    success: false,
                    error: `Failed to reset password: ${resetResult}`,
                    debug: logs.join('\n')
                };
            }
            
            reused = true;
        } else {
            // Create new user
            const randomSuffix = crypto.randomBytes(4).toString('hex');
            username = `websync_admin_${randomSuffix}`;
            password = crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
            const email = `${username}@websync.local`;
            
            logs.push(`Creating new user: ${username}`);
            
            const createCmd = `cd ${wpPath} && ${wpCliPath} user create "${username}" "${email}" --user_pass="${password}" --role=administrator --allow-root 2>&1`;
            const createResult = await executeCommand(containerName, ['sh', '-c', createCmd]);
            logs.push(`Create result: ${createResult}`);
            
            // Verify user was created
            const verifyCmd = `cd ${wpPath} && ${wpCliPath} user get "${username}" --field=ID --allow-root 2>&1`;
            const verifyResult = await executeCommand(containerName, ['sh', '-c', verifyCmd]);
            logs.push(`Verify result: ${verifyResult}`);
            
            const userId = parseInt(verifyResult.trim(), 10);
            if (isNaN(userId)) {
                return {
                    success: false,
                    error: `User creation failed. Output: ${createResult}`,
                    debug: logs.join('\n')
                };
            }
            
            logs.push(`User created with ID: ${userId}`);
        }
        
        const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
        
        // Schedule cleanup (delete user after expiration) - only for new users
        if (!reused) {
            setTimeout(async () => {
                try {
                    const deleteCmd = `cd ${wpPath} && ${wpCliPath} user delete ${username} --yes --allow-root 2>/dev/null || true`;
                    await executeCommand(containerName, ['sh', '-c', deleteCmd]);
                    console.log(`Deleted expired WordPress admin: ${username}`);
                } catch (e) {
                    console.error(`Failed to delete expired WordPress admin: ${username}`, e);
                }
            }, expiresInHours * 60 * 60 * 1000);
        }
        
        console.log(`WordPress admin ${reused ? 'reused' : 'created'}: ${username} (expires: ${expiresAt.toISOString()})`);
        
        return {
            success: true,
            username,
            password,
            expiresAt: expiresAt.toISOString(),
            reused,
            debug: logs.join('\n')
        };
    } catch (error: any) {
        logs.push(`Exception: ${error.message}`);
        console.error('generateWpAdmin error:', error);
        return {
            success: false,
            error: error.message || 'Failed to generate WordPress admin',
            debug: logs.join('\n')
        };
    }
};

/**
 * Delete a WordPress admin user
 */
export const deleteWpAdmin = async (
    containerName: string,
    username: string,
    wpPath: string = '/var/www/html'
): Promise<{ success: boolean; error?: string }> => {
    try {
        const result = await executeCommand(containerName, [
            'sh', '-c',
            `cd ${wpPath} && wp user delete ${username} --yes --allow-root 2>&1`
        ]);
        
        if (result.toLowerCase().includes('error') && !result.includes('Success')) {
            return { success: false, error: result };
        }
        
        return { success: true };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};

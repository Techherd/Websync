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

const WEBSYNC_ADMIN_USERNAME = 'websync_admin';

/**
 * Create or rotate the persistent WordPress admin user managed by WebSync.
 * Idempotent: uses a stable `websync_admin` user across calls and resets its
 * password on each invocation. Caller is responsible for persisting the
 * returned credentials.
 */
export const generateWpAdmin = async (
    containerName: string,
    wpPath: string = '/var/www/html'
): Promise<{
    success: boolean;
    username?: string;
    password?: string;
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
        
        // Step 4: Check for an existing websync_admin user (current or legacy random-suffixed)
        const listCmd = `cd ${wpPath} && ${wpCliPath} user list --field=user_login --allow-root 2>&1 | grep "^websync_admin" | head -1`;
        const existingUser = (await executeCommand(containerName, ['sh', '-c', listCmd])).trim();
        logs.push(`Existing user check: "${existingUser}"`);

        const password = crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
        let username = WEBSYNC_ADMIN_USERNAME;
        let reused = false;

        if (existingUser && existingUser.startsWith('websync_admin')) {
            username = existingUser;
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
            const email = `${username}@websync.local`;
            logs.push(`Creating new user: ${username}`);
            const createCmd = `cd ${wpPath} && ${wpCliPath} user create "${username}" "${email}" --user_pass="${password}" --role=administrator --allow-root 2>&1`;
            const createResult = await executeCommand(containerName, ['sh', '-c', createCmd]);
            logs.push(`Create result: ${createResult}`);

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

        console.log(`WordPress admin ${reused ? 'reset' : 'created'}: ${username}`);

        return {
            success: true,
            username,
            password,
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
 * Strip PHP Warning/Notice/Deprecated lines so real errors aren't buried.
 */
const filterPhpNoise = (output: string): string =>
    output
        .split('\n')
        .map(s => s.trim())
        .filter(s => s && !/^(\[[^\]]+\]\s+)?(PHP\s+)?(Warning|Notice|Deprecated):/i.test(s) && !/^Warning:/i.test(s))
        .join('\n')
        .trim();

/**
 * Locate the WP-CLI binary inside a container, checking $PATH and common install paths.
 */
export const findWpCli = async (containerName: string, wpPath: string): Promise<string | null> => {
    try {
        const which = (await executeCommand(containerName, ['sh', '-c', 'which wp 2>/dev/null || echo ""'])).trim();
        if (which) return which;
    } catch {}
    for (const candidate of ['/usr/local/bin/wp', '/usr/bin/wp', `${wpPath}/wp-cli.phar`]) {
        try {
            const result = await executeCommand(containerName, ['sh', '-c', `test -f ${candidate} && echo exists || echo no`]);
            if (result.includes('exists')) return candidate;
        } catch {}
    }
    return null;
};

/**
 * Generate a one-time magic login URL for the given WordPress user.
 * Requires the `aaemnnosttv/wp-cli-login-command` package to be installed in
 * the container. If absent, attempts to install it automatically (one-time).
 */
export const generateMagicLoginUrl = async (
    containerName: string,
    username: string,
    wpPath: string = '/var/www/html'
): Promise<{ success: boolean; url?: string; error?: string; debug?: string }> => {
    const logs: string[] = [];
    try {
        const wpCli = await findWpCli(containerName, wpPath);
        if (!wpCli) {
            return { success: false, error: 'WP-CLI not found in container', debug: logs.join('\n') };
        }
        logs.push(`wp-cli: ${wpCli}`);

        // Check if the login command is registered
        const hasLogin = await executeCommand(containerName, [
            'sh', '-c',
            `cd ${wpPath} && ${wpCli} cli has-command login --allow-root 2>/dev/null && echo yes || echo no`
        ]);
        logs.push(`has login command: ${hasLogin.trim()}`);

        if (!hasLogin.includes('yes')) {
            // Try to install the login command (and its companion mu-plugin)
            const installPkg = await executeCommand(containerName, [
                'sh', '-c',
                `cd ${wpPath} && ${wpCli} package install aaemnnosttv/wp-cli-login-command --allow-root 2>&1`
            ]);
            logs.push(`package install: ${installPkg}`);
            const installCmd = await executeCommand(containerName, [
                'sh', '-c',
                `cd ${wpPath} && ${wpCli} login install --activate --yes --allow-root 2>&1`
            ]);
            logs.push(`login install: ${installCmd}`);
        }

        const magic = await executeCommand(containerName, [
            'sh', '-c',
            `cd ${wpPath} && ${wpCli} login as "${username}" --url-only --allow-root 2>&1`
        ]);
        logs.push(`magic url result: ${magic}`);

        const url = magic.split('\n').map(s => s.trim()).find(s => /^https?:\/\//.test(s));
        if (!url) {
            const realError = filterPhpNoise(magic) || magic.trim();
            return {
                success: false,
                error: `Could not generate magic link: ${realError}`,
                debug: logs.join('\n')
            };
        }

        return { success: true, url, debug: logs.join('\n') };
    } catch (error: any) {
        logs.push(`Exception: ${error.message}`);
        return { success: false, error: error.message || 'Failed to generate magic link', debug: logs.join('\n') };
    }
};

export interface MagicSetupStep {
    name: string;
    success: boolean;
    output: string;
    skipped?: boolean;
}

/**
 * Prepare a WordPress site for magic-link login:
 *   1. Install the wp-cli-login-command package (CLI extension)
 *   2. Install + activate the companion plugin (wp-cli-login-server)
 *   3. Set a known endpoint (so one Cloudflare / WAF rule covers every site)
 *   4. Flush rewrite rules so the new endpoint takes effect immediately
 *
 * Idempotent — safe to run multiple times. Steps 1 & 2 are skipped if already done.
 */
export const setupMagicLogin = async (
    containerName: string,
    wpPath: string = '/var/www/html',
    endpoint: string = 'wpcli-magic'
): Promise<{ success: boolean; steps: MagicSetupStep[]; error?: string }> => {
    const wpCli = await findWpCli(containerName, wpPath);
    if (!wpCli) {
        return { success: false, steps: [], error: 'WP-CLI not found in container' };
    }

    const run = async (
        name: string,
        cmd: string,
        skipIfTrue?: boolean
    ): Promise<MagicSetupStep> => {
        if (skipIfTrue) {
            return { name, success: true, output: 'Already installed', skipped: true };
        }
        try {
            const raw = await executeCommand(containerName, ['sh', '-c', cmd]);
            const cleaned = filterPhpNoise(raw) || raw.trim();
            const lower = cleaned.toLowerCase();
            // WP-CLI prefixes errors with "Error:" — treat as failure unless a Success appears
            const failed = /(^|\n)error:/i.test(cleaned) && !/(^|\n)success:/i.test(cleaned);
            return { name, success: !failed, output: cleaned };
        } catch (e: any) {
            return { name, success: false, output: e.message || String(e) };
        }
    };

    // Detect already-installed state so we report "Already installed" instead of churning
    let pkgInstalled = false;
    try {
        const check = await executeCommand(containerName, [
            'sh', '-c',
            `cd ${wpPath} && ${wpCli} cli has-command login --allow-root 2>/dev/null && echo yes || echo no`
        ]);
        pkgInstalled = check.includes('yes');
    } catch {}

    let pluginActive = false;
    try {
        const check = await executeCommand(containerName, [
            'sh', '-c',
            `cd ${wpPath} && ${wpCli} plugin is-active wp-cli-login-server --allow-root >/dev/null 2>&1 && echo yes || echo no`
        ]);
        pluginActive = check.includes('yes');
    } catch {}

    const steps: MagicSetupStep[] = [];
    steps.push(await run(
        'Install wp-cli-login-command package',
        `cd ${wpPath} && ${wpCli} package install aaemnnosttv/wp-cli-login-command --allow-root 2>&1`,
        pkgInstalled
    ));
    steps.push(await run(
        'Install + activate companion plugin',
        `cd ${wpPath} && ${wpCli} login install --activate --yes --allow-root 2>&1`,
        pluginActive
    ));
    // Write the wp_cli_login option.
    //
    // The companion plugin stores its config as a JSON *string* (it calls
    // json_decode() on read). We MUST store as a string — not as a serialized
    // PHP array — or the plugin crashes with a fatal at LoginCommand.php:243.
    //
    // `wp option update <name> <json>` (without --format=json) writes the value
    // as a string, which matches the plugin's expectation. This works whether
    // the option currently exists, is missing, or is in a broken state from a
    // previous --format=json write.
    steps.push(await run(
        `Set magic endpoint to "${endpoint}"`,
        `cd ${wpPath} && ${wpCli} option update wp_cli_login '{"endpoint":"${endpoint}","version":"^1.5"}' --allow-root 2>&1`
    ));
    steps.push(await run(
        'Flush rewrite rules',
        `cd ${wpPath} && ${wpCli} rewrite flush --allow-root 2>&1`
    ));

    return { success: steps.every(s => s.success), steps };
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

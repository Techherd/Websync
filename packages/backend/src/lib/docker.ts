import Docker from 'dockerode';
import crypto from 'crypto';

// DOCKER_SOCKET lets local dev point at e.g. Docker Desktop's ~/.docker/run/docker.sock
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });

export const getDocker = () => docker;

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

        // Step 1-2: Locate WP-CLI (and repair a broken packages dir if needed)
        const wpCliPath = await findWpCli(containerName, wpPath);

        if (!wpCliPath) {
            logs.push('WP-CLI not found in container');
            return {
                success: false,
                error: 'WP-CLI not found in container. Please install WP-CLI in your WordPress container.',
                debug: logs.join('\n')
            };
        }
        
        logs.push(`Using WP-CLI at: ${wpCliPath}`);
        
        // Step 3: Verify WordPress is installed at the path. Go by exit code, not
        // output text — PHP warnings from plugins routinely contain "error".
        const wpCheckCmd = `cd ${wpPath} && ${wpCliPath} core is-installed --allow-root 2>&1; echo "__EXIT_$?"`;
        const wpCheckResult = await executeCommand(containerName, ['sh', '-c', wpCheckCmd]);
        logs.push(`WP check: ${wpCheckResult}`);

        if (!wpCheckResult.includes('__EXIT_0')) {
            const detail = filterPhpNoise(wpCheckResult.replace(/__EXIT_\d+/, ''));
            return {
                success: false,
                error: detail
                    ? `WP-CLI could not load WordPress at ${wpPath}: ${detail.split('\n')[0]}`
                    : `WordPress not found at ${wpPath}. Check the WP Path setting.`,
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

// Shell expression (not JS-interpolated) for WP-CLI's community packages dir.
const WP_CLI_PACKAGES_DIR = '"${WP_CLI_PACKAGES_DIR:-$HOME/.wp-cli/packages}"';

const isBrokenPackagesOutput = (output: string): boolean =>
    /fatal error/i.test(output) && output.includes('.wp-cli/packages');

/**
 * A half-finished `wp package install` leaves Composer's autoloader pointing at
 * files that don't exist, and every WP-CLI command then dies with a fatal
 * before it ever touches WordPress. Detect that and move the packages dir aside
 * (kept as `packages.broken-<timestamp>`) so WP-CLI works again. The magic-login
 * package is reinstalled on demand afterwards.
 */
export const repairWpCliPackages = async (
    containerName: string,
    wpCli: string
): Promise<{ repaired: boolean; error?: string }> => {
    const versionCmd = ['sh', '-c', `${wpCli} cli version --allow-root 2>&1`];
    if (!isBrokenPackagesOutput(await executeCommand(containerName, versionCmd))) {
        return { repaired: false };
    }
    await executeCommand(containerName, [
        'sh', '-c',
        `d=${WP_CLI_PACKAGES_DIR}; mv "$d" "$d.broken-$(date +%s)" 2>&1`
    ]);
    const after = await executeCommand(containerName, versionCmd);
    if (isBrokenPackagesOutput(after)) {
        return { repaired: false, error: 'WP-CLI packages are broken and could not be moved aside' };
    }
    console.warn(`Repaired broken WP-CLI packages dir in ${containerName}`);
    return { repaired: true };
};

/**
 * Locate the WP-CLI binary inside a container, checking $PATH and common install
 * paths. Also repairs a broken WP-CLI packages dir so callers get a working CLI.
 */
export const findWpCli = async (containerName: string, wpPath: string): Promise<string | null> => {
    const wpCli = await locateWpCli(containerName, wpPath);
    if (wpCli) await repairWpCliPackages(containerName, wpCli).catch(() => {});
    return wpCli;
};

const locateWpCli = async (containerName: string, wpPath: string): Promise<string | null> => {
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
 * Install the magic-login CLI package. If the install leaves WP-CLI broken
 * (e.g. interrupted, or the image can't fetch the package), roll it back so the
 * rest of WebSync keeps working, and report the failure.
 */
const installLoginPackage = async (
    containerName: string,
    wpCli: string,
    wpPath: string
): Promise<{ success: boolean; output: string }> => {
    const raw = await executeCommand(containerName, [
        'sh', '-c',
        `cd ${wpPath} && ${wpCli} package install aaemnnosttv/wp-cli-login-command --allow-root 2>&1`
    ]);
    const output = filterPhpNoise(raw) || raw.trim();
    const { repaired } = await repairWpCliPackages(containerName, wpCli);
    if (repaired) {
        return {
            success: false,
            output: `${output}\nPackage install left WP-CLI broken and was rolled back. ` +
                'It was probably interrupted, or the container could not reach GitHub. Try again.'
        };
    }
    const failed = /(^|\n)error:/i.test(output) && !/(^|\n)success:/i.test(output);
    return { success: !failed, output };
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
            const installPkg = await installLoginPackage(containerName, wpCli, wpPath);
            logs.push(`package install: ${installPkg.output}`);
            if (!installPkg.success) {
                return { success: false, error: `Could not install magic-login package: ${installPkg.output}`, debug: logs.join('\n') };
            }
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
    const pkgStepName = 'Install wp-cli-login-command package';
    if (pkgInstalled) {
        steps.push({ name: pkgStepName, success: true, output: 'Already installed', skipped: true });
    } else {
        const pkg = await installLoginPackage(containerName, wpCli, wpPath)
            .catch((e: any) => ({ success: false, output: e.message || String(e) }));
        steps.push({ name: pkgStepName, ...pkg });
        if (!pkg.success) return { success: false, steps };
    }
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

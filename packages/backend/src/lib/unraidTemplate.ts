import fs from 'fs/promises';
import path from 'path';

/**
 * Unraid's Docker manager keeps one XML template per container in
 * templates-user/my-<Name>.xml and rebuilds the container from it on Edit and
 * Update. Writing a template next to each container WebSync creates makes
 * provisioned sites behave like ones set up by hand in the Unraid UI.
 */
export const UNRAID_TEMPLATES_DIR =
    process.env.UNRAID_TEMPLATES_DIR || '/boot/config/plugins/dockerMan/templates-user';
export const UNRAID_DOCKER_CFG =
    process.env.UNRAID_DOCKER_CFG || '/boot/config/docker.cfg';

export interface TemplateConfig {
    name: string;
    target: string;
    type: 'Port' | 'Path' | 'Variable';
    value: string;
    mode?: string;          // tcp/udp for ports, rw/ro for paths
    description?: string;
    display?: 'always' | 'always-hide' | 'advanced' | 'advanced-hide';
    required?: boolean;
    mask?: boolean;         // hide the value in Unraid's UI (passwords)
}

export interface UnraidTemplate {
    name: string;
    repository: string;
    registry?: string;
    network: string;
    webUI?: string;         // e.g. http://[IP]:[PORT:80]/
    icon?: string;
    overview?: string;
    category?: string;
    project?: string;
    extraParams?: string;
    configs: TemplateConfig[];
}

const esc = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/\r?\n/g, '&#13;\n');

const tag = (name: string, value?: string): string =>
    value ? `  <${name}>${esc(value)}</${name}>` : `  <${name}/>`;

export const renderTemplate = (t: UnraidTemplate): string => {
    const configs = t.configs.map(c =>
        `  <Config Name="${esc(c.name)}" Target="${esc(c.target)}" Default="" Mode="${esc(c.mode || '')}" ` +
        `Description="${esc(c.description || '')}" Type="${c.type}" Display="${c.display || 'always'}" ` +
        `Required="${c.required ? 'true' : 'false'}" Mask="${c.mask ? 'true' : 'false'}">${esc(c.value)}</Config>`
    );
    return [
        '<?xml version="1.0"?>',
        '<Container version="2">',
        tag('Name', t.name),
        tag('Repository', t.repository),
        tag('Registry', t.registry),
        tag('Network', t.network),
        tag('MyIP'),
        tag('MyMAC'),
        tag('Shell', 'sh'),
        tag('Privileged', 'false'),
        tag('Support'),
        tag('Project', t.project),
        tag('ReadMe'),
        tag('Overview', t.overview),
        tag('Category', t.category),
        tag('WebUI', t.webUI),
        tag('TemplateURL'),
        tag('Icon', t.icon),
        tag('ExtraParams', t.extraParams),
        tag('PostArgs'),
        tag('CPUset'),
        tag('DateInstalled', String(Math.floor(Date.now() / 1000))),
        tag('DonateText'),
        tag('DonateLink'),
        tag('Requires'),
        ...configs,
        tag('TailscaleStateDir'),
        '</Container>',
        ''
    ].join('\n');
};

export const templatePath = (containerName: string): string =>
    path.join(UNRAID_TEMPLATES_DIR, `my-${containerName}.xml`);

export const writeTemplate = async (t: UnraidTemplate): Promise<string> => {
    const file = templatePath(t.name);
    await fs.writeFile(file, renderTemplate(t), { mode: 0o600 });
    return file;
};

/**
 * Host ports claimed by any Unraid template, including containers that are
 * stopped (Docker only reports published ports for running containers).
 */
export const templatePorts = async (): Promise<Set<number>> => {
    const ports = new Set<number>();
    let files: string[] = [];
    try {
        files = (await fs.readdir(UNRAID_TEMPLATES_DIR)).filter(f => f.endsWith('.xml'));
    } catch {
        return ports;
    }
    for (const file of files) {
        try {
            const xml = await fs.readFile(path.join(UNRAID_TEMPLATES_DIR, file), 'utf8');
            for (const match of xml.matchAll(/Type="Port"[^>]*>(\d+)</g)) ports.add(Number(match[1]));
        } catch {}
    }
    return ports;
};

/**
 * Unraid deletes user-defined Docker networks on every Docker restart unless
 * "Preserve user defined networks" is on. Returns null if docker.cfg isn't
 * mounted into WebSync (can't tell).
 */
export const userNetworksPreserved = async (): Promise<boolean | null> => {
    try {
        const cfg = await fs.readFile(UNRAID_DOCKER_CFG, 'utf8');
        const match = cfg.match(/^DOCKER_USER_NETWORKS="?([^"\n]*)"?/m);
        return match?.[1].trim() === 'preserve';
    } catch {
        return null;
    }
};

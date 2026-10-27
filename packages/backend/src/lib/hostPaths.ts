import os from 'os';
import { getContainerParams } from './docker';

interface BindMount {
    source: string;       // path on the Docker host
    destination: string;  // path inside the WebSync container
}

let cachedMounts: BindMount[] | null | undefined;

/**
 * Bind mounts of the WebSync container itself, longest destination first.
 * Returns null when WebSync isn't running in Docker (local dev), in which case
 * container paths and host paths are the same thing.
 *
 * Unraid sets HOST_CONTAINERNAME on containers it creates; otherwise Docker's
 * default hostname is the container ID, which `inspect` also accepts.
 */
const getOwnMounts = async (): Promise<BindMount[] | null> => {
    if (cachedMounts !== undefined) return cachedMounts;
    try {
        const info = await getContainerParams(process.env.HOST_CONTAINERNAME || os.hostname());
        cachedMounts = (info.Mounts || [])
            .filter(m => m.Type === 'bind')
            .map(m => ({ source: m.Source, destination: m.Destination }))
            .sort((a, b) => b.destination.length - a.destination.length);
    } catch {
        cachedMounts = null;
    }
    return cachedMounts;
};

/**
 * Translate a path as WebSync sees it into the path on the Docker host, which
 * is what new containers' bind mounts and Unraid templates need. On th-mh,
 * `/mnt/user/appdata/...` inside WebSync is `/mnt/cache/appdata/...` on the host.
 */
export const toHostPath = async (containerPath: string): Promise<string> => {
    const mounts = await getOwnMounts();
    if (!mounts) return containerPath;
    const mount = mounts.find(m =>
        containerPath === m.destination || containerPath.startsWith(`${m.destination}/`)
    );
    if (!mount) {
        throw new Error(`${containerPath} is not on a volume mounted into WebSync, so new containers can't use it`);
    }
    return mount.source + containerPath.slice(mount.destination.length);
};

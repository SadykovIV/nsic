import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import type { SwitchFile } from './inventory';

export async function selectSwitchFiles(): Promise<string[]> {
    const result = await open({
        title: 'Select Nintendo Switch files',
        multiple: true,
        filters: [
            { name: 'Switch packages', extensions: ['nsp', 'nsz', 'xci', 'xcz'] },
            { name: 'All files', extensions: ['*'] },
        ],
    });
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
}

export async function selectDirectory(title?: string): Promise<string | null> {
    const result = await open({ title, directory: true, multiple: false });
    return result as string | null;
}

export async function inspectPaths(paths: string[], recursive = true): Promise<SwitchFile[]> {
    if (paths.length === 0) return [];
    return invoke<SwitchFile[]>('inspect_switch_paths', { paths, recursive });
}

export async function hasKeys(): Promise<boolean> {
    return invoke<boolean>('has_keys').catch(() => false);
}

export async function importKeys(): Promise<{ ok: boolean; error?: string }> {
    const selected = await open({
        title: 'Select your legally obtained prod.keys',
        multiple: false,
        filters: [
            { name: 'Keys file', extensions: ['keys', 'txt'] },
            { name: 'All files', extensions: ['*'] },
        ],
    });
    if (!selected) return { ok: false };
    try {
        await invoke('import_keys', { srcPath: selected as string });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}

export async function removeKeys(): Promise<void> {
    await invoke('remove_keys');
}

export async function hasBackend(): Promise<boolean> {
    return invoke<boolean>('has_backend').catch(() => false);
}

export async function importBackend(): Promise<{ ok: boolean; error?: string }> {
    const selected = await open({ title: 'Select nscb_rust-macos-arm64', multiple: false });
    if (!selected) return { ok: false };
    try {
        await invoke('import_nscb_binary', { srcPath: selected as string });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: String(error) };
    }
}

export interface BackendRelease {
    tag: string;
    downloadUrl: string;
    pageUrl: string;
}

export async function fetchLatestBackendRelease(): Promise<BackendRelease | null> {
    try {
        const response = await fetch('https://api.github.com/repos/cxfcxf/nscb_rust/releases/latest');
        if (!response.ok) return null;
        const data = await response.json() as {
            tag_name?: string;
            html_url?: string;
            assets?: Array<{ name?: string; browser_download_url?: string }>;
        };
        const asset = data.assets?.find((item) =>
            item.name === 'nscb_rust-macos-arm64'
            || (item.name?.includes('macos') && item.name?.includes('arm64')),
        );
        if (!data.tag_name || !asset?.browser_download_url) return null;
        return {
            tag: data.tag_name,
            downloadUrl: asset.browser_download_url,
            pageUrl: data.html_url ?? 'https://github.com/cxfcxf/nscb_rust/releases',
        };
    } catch {
        return null;
    }
}

export async function downloadBackend(release: BackendRelease): Promise<void> {
    await invoke('download_backend', { url: release.downloadUrl });
    await invoke('save_backend_version', { version: release.tag });
}

export async function getBackendVersion(): Promise<string> {
    return invoke<string>('get_backend_version').catch(() => '');
}

export async function getToolsDirectory(): Promise<string> {
    return invoke<string>('get_tools_dir');
}

export async function getSetting(key: string): Promise<string> {
    return invoke<string>('get_setting', { key }).catch(() => '');
}

export async function saveSetting(key: string, value: string): Promise<void> {
    await invoke('save_setting', { key, value });
}

export async function revealPath(path: string): Promise<void> {
    await openPath(path);
}

export async function openExternal(url: string): Promise<void> {
    await openUrl(url);
}

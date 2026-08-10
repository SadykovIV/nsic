export type ContentKind = 'base' | 'update' | 'dlc' | 'unknown';

export interface SwitchFile {
    path: string;
    name: string;
    extension: string;
    size: number;
    modifiedMs: number | null;
    kind: ContentKind;
    titleId: string | null;
    version: number | null;
}

export interface SelectedSwitchFile extends SwitchFile {
    selected: boolean;
}

export interface InventoryAnalysis {
    selectedCount: number;
    totalSize: number;
    baseCount: number;
    updateCount: number;
    dlcCount: number;
    unknownCount: number;
    baseTitleIds: string[];
    warnings: string[];
    blockingError: string | null;
}

// These It Takes Two packages are alternative entitlements, not cumulative DLC.
// Keep the rule explicit so NSIC never silently drops a user-selected package.
const KNOWN_CONFLICTING_DLC_SETS = [
    ['010092A0172E5001', '010092A0172E5002'],
] as const;

export function baseTitleId(titleId: string, kind?: ContentKind): string {
    const normalized = titleId.toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(normalized)) return normalized;

    const value = BigInt(`0x${normalized}`);
    const suffix = Number(value & 0xfffn);
    const inferredKind = kind ?? (suffix === 0x800 ? 'update' : suffix >= 1 && suffix <= 0x7ff ? 'dlc' : 'base');

    let baseValue = value;
    if (inferredKind === 'update') {
        baseValue = value - 0x800n;
    } else if (inferredKind === 'dlc') {
        baseValue = (value & ~0xfffn) - 0x1000n;
    }

    return baseValue.toString(16).toUpperCase().padStart(16, '0');
}

export function analyzeInventory(files: SelectedSwitchFile[]): InventoryAnalysis {
    const selected = files.filter((file) => file.selected);
    const baseCount = selected.filter((file) => file.kind === 'base').length;
    const updateCount = selected.filter((file) => file.kind === 'update').length;
    const dlcCount = selected.filter((file) => file.kind === 'dlc').length;
    const unknownCount = selected.filter((file) => file.kind === 'unknown').length;
    const baseTitleIds = Array.from(new Set(
        selected
            .filter((file): file is SelectedSwitchFile & { titleId: string } => Boolean(file.titleId))
            .map((file) => baseTitleId(file.titleId, file.kind)),
    )).sort();

    const warnings: string[] = [];
    let blockingError: string | null = null;
    if (selected.length === 0) blockingError = 'no_files';
    else if (baseCount === 0 && unknownCount === 0) blockingError = 'no_base';
    if (baseTitleIds.length > 1) warnings.push('multiple_titles');
    if (unknownCount > 0) warnings.push('unknown_content');
    if (updateCount > 1) warnings.push('multiple_updates');
    const selectedTitleIds = new Set(
        selected
            .map((file) => file.titleId?.toUpperCase())
            .filter((titleId): titleId is string => Boolean(titleId)),
    );
    if (KNOWN_CONFLICTING_DLC_SETS.some((set) => set.every((titleId) => selectedTitleIds.has(titleId)))) {
        warnings.push('conflicting_entitlements');
    }

    return {
        selectedCount: selected.length,
        totalSize: selected.reduce((sum, file) => sum + file.size, 0),
        baseCount,
        updateCount,
        dlcCount,
        unknownCount,
        baseTitleIds,
        warnings,
        blockingError,
    };
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** index);
    return `${value.toFixed(index === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
}

export function formatDuration(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
    return [minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
}

export function findBuiltXci(before: SwitchFile[], after: SwitchFile[], startedAtMs: number): SwitchFile | null {
    const previous = new Map(before.map((file) => [file.path, file.modifiedMs]));
    return after
        .filter((file) => file.extension.toLowerCase() === 'xci')
        .filter((file) => !previous.has(file.path) || (file.modifiedMs ?? 0) > (previous.get(file.path) ?? 0))
        .filter((file) => (file.modifiedMs ?? startedAtMs) >= startedAtMs - 2000)
        .sort((left, right) => (right.modifiedMs ?? 0) - (left.modifiedMs ?? 0))[0] ?? null;
}

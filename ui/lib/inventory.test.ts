import { describe, expect, it } from 'vitest';
import { analyzeInventory, baseTitleId, findBuiltXci, formatBytes, formatDuration, type SelectedSwitchFile, type SwitchFile } from './inventory';

function file(overrides: Partial<SelectedSwitchFile> = {}): SelectedSwitchFile {
    return {
        path: '/Games/game.nsp', name: 'game.nsp', extension: 'nsp', size: 1024,
        modifiedMs: 100, kind: 'base', titleId: '0100123412345000', version: 0,
        selected: true, ...overrides,
    };
}

describe('inventory analysis', () => {
    it('groups base, update and DLC under one base title ID', () => {
        const result = analyzeInventory([
            file({ titleId: '010092A0172E4000' }),
            file({ path: '/Games/update.nsz', kind: 'update', titleId: '010092A0172E4800', version: 65536 }),
            file({ path: '/Games/dlc-1.nsp', kind: 'dlc', titleId: '010092A0172E5001' }),
            file({ path: '/Games/dlc-2.nsp', kind: 'dlc', titleId: '010092A0172E5002' }),
        ]);
        expect(result.blockingError).toBeNull();
        expect(result.baseTitleIds).toEqual(['010092A0172E4000']);
        expect([result.baseCount, result.updateCount, result.dlcCount]).toEqual([1, 1, 2]);
        expect(result.warnings).not.toContain('multiple_titles');
    });

    it('blocks update-only input', () => {
        expect(analyzeInventory([file({ kind: 'update', titleId: '0100123412345800' })]).blockingError).toBe('no_base');
    });

    it('recognises update and DLC from one game while still requiring its base', () => {
        const result = analyzeInventory([
            file({ kind: 'update', titleId: '010092A0172E4800' }),
            file({ kind: 'dlc', titleId: '010092A0172E5001' }),
            file({ kind: 'dlc', titleId: '010092A0172E5002' }),
        ]);
        expect(result.baseTitleIds).toEqual(['010092A0172E4000']);
        expect(result.warnings).not.toContain('multiple_titles');
        expect(result.blockingError).toBe('no_base');
    });

    it('warns when multiple games are mixed', () => {
        expect(analyzeInventory([file(), file({ path: '/Games/other.nsp', titleId: '0100999999999000' })]).warnings)
            .toContain('multiple_titles');
    });

    it('blocks the mutually exclusive It Takes Two Full Game and Friends Pass entitlements', () => {
        const result = analyzeInventory([
            file({ titleId: '010092A0172E4000' }),
            file({ path: '/Games/full-game.nsp', kind: 'dlc', titleId: '010092A0172E5001' }),
            file({ path: '/Games/friends-pass.nsp', kind: 'dlc', titleId: '010092A0172E5002' }),
        ]);
        expect(result.warnings).toContain('conflicting_entitlements');
    });

    it('allows the verified It Takes Two Full Game entitlement by itself', () => {
        const result = analyzeInventory([
            file({ titleId: '010092A0172E4000' }),
            file({ path: '/Games/full-game.nsp', kind: 'dlc', titleId: '010092A0172E5001' }),
        ]);
        expect(result.warnings).not.toContain('conflicting_entitlements');
    });
});

describe('inventory helpers', () => {
    it('normalises related title IDs', () => {
        expect(baseTitleId('0100123412345800')).toBe('0100123412345000');
        expect(baseTitleId('010092A0172E5001')).toBe('010092A0172E4000');
        expect(baseTitleId('010092A0172E5002')).toBe('010092A0172E4000');
    });

    it('formats byte sizes and durations', () => {
        expect(formatBytes(1536)).toBe('1.50 KiB');
        expect(formatDuration(3661)).toBe('01:01:01');
    });

    it('finds the newest XCI produced by a build', () => {
        const xci = (path: string, modifiedMs: number): SwitchFile => ({
            path, name: path.split('/').pop()!, extension: 'xci', size: 1,
            modifiedMs, kind: 'base', titleId: null, version: null,
        });
        expect(findBuiltXci([xci('/out/old.xci', 100)], [xci('/out/old.xci', 200), xci('/out/new.xci', 300)], 150)?.path)
            .toBe('/out/new.xci');
    });
});

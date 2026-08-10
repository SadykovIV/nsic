import { describe, expect, it } from 'vitest';
import { basename, buildArgs, dirname, parseProgressLine, parseResultLine } from './nscb-runner';

describe('path helpers', () => {
    it('handle Unix and Windows paths', () => {
        expect(basename('/Games/title.nsp')).toBe('title.nsp');
        expect(dirname('C:\\Games\\title.nsp')).toBe('C:/Games');
    });
});

describe('progress parsing', () => {
    it('parses binary byte progress, speed and ETA', () => {
        const result = parseProgressLine('Building XCI [====>---] 1.25 GiB/5.00 GiB (64.0 MiB/s, 1m 2s)');
        expect(result?.percent).toBeCloseTo(25);
        expect(result?.message).toBe('Building XCI');
        expect(result?.speed).toBe('64.0 MiB/s');
        expect(result?.etaSeconds).toBe(62);
    });

    it('parses custom pipeline stages', () => {
        expect(parseProgressLine('NSIC_PROGRESS 58 | Applying RomFS overlay')).toMatchObject({ percent: 58, message: 'Applying RomFS overlay' });
    });
});

describe('patched build result parsing', () => {
    it('preserves an exact XCI path containing spaces', () => {
        expect(parseResultLine('NSIC_RESULT: /Output/It Takes Two [010092A0172E4000].xci'))
            .toBe('/Output/It Takes Two [010092A0172E4000].xci');
    });

    it('ignores ordinary backend output', () => {
        expect(parseResultLine('Building XCI')).toBeNull();
    });
});

describe('XCI merge arguments', () => {
    it('always selects XCI and keeps firmware patching opt-in', () => {
        const args = buildArgs('merge', ['/Games/base.nsp', '/Games/update.nsz'], { output: '/Output', nodelta: true }, '/App/prod.keys');
        expect(args).toEqual(['-d', '/Games/base.nsp', '/Games/update.nsz', '-t', 'xci', '-n', '-o', '/Output', '--keys', '/App/prod.keys']);
        expect(args).not.toContain('--RSVcap');
        expect(args).not.toContain('-k');
    });

    it('passes explicitly selected firmware controls and temporary directory', () => {
        const args = buildArgs('merge', ['/Games/base.nsp'], { rsvcap: '17', keypatch: '16', showFirmware: true, tempDir: '/Volumes/Fast/tmp' });
        expect(args).toContain('--pv');
        expect(args.slice(args.indexOf('--RSVcap'), args.indexOf('--RSVcap') + 2)).toEqual(['--RSVcap', '17']);
        expect(args.slice(args.indexOf('-k'), args.indexOf('-k') + 2)).toEqual(['-k', '16']);
        expect(args.slice(args.indexOf('--temp-dir'))).toEqual(['--temp-dir', '/Volumes/Fast/tmp']);
    });
});

describe('verification arguments', () => {
    it('uses a non-interactive file list and signature verification by default', () => {
        expect(buildArgs('verify', ['/Output/game.xci'], { filelistPath: '/tmp/list.txt' }, '/App/prod.keys')).toEqual([
            '--verify', 'all', '--text_file', '/tmp/list.txt', '--vertype', 'lv2', '--keys', '/App/prod.keys',
        ]);
    });
});

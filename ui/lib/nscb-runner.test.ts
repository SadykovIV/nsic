import { describe, expect, it } from 'vitest';
import { basename, buildArgs, dirname } from './nscb-runner';

describe('path helpers', () => {
    it('handle Unix and Windows paths', () => {
        expect(basename('/Games/title.nsp')).toBe('title.nsp');
        expect(dirname('C:\\Games\\title.nsp')).toBe('C:/Games');
    });
});

describe('XCI merge arguments', () => {
    it('always selects XCI and keeps firmware patching opt-in', () => {
        const args = buildArgs('merge', ['/Games/base.nsp', '/Games/update.nsz'], {
            output: '/Output', nodelta: true,
        }, '/App/prod.keys');
        expect(args).toEqual([
            '-d', '/Games/base.nsp', '/Games/update.nsz', '-t', 'xci', '-n',
            '-o', '/Output', '--keys', '/App/prod.keys',
        ]);
        expect(args).not.toContain('--RSVcap');
        expect(args).not.toContain('-k');
    });

    it('passes explicitly selected firmware controls', () => {
        const args = buildArgs('merge', ['/Games/base.nsp'], { rsvcap: '17', keypatch: '16', showFirmware: true });
        expect(args).toContain('--pv');
        expect(args.slice(args.indexOf('--RSVcap'), args.indexOf('--RSVcap') + 2)).toEqual(['--RSVcap', '17']);
        expect(args.slice(args.indexOf('-k'), args.indexOf('-k') + 2)).toEqual(['-k', '16']);
    });
});

describe('verification arguments', () => {
    it('uses a non-interactive file list and signature verification by default', () => {
        expect(buildArgs('verify', ['/Output/game.xci'], { filelistPath: '/tmp/list.txt' }, '/App/prod.keys')).toEqual([
            '--verify', 'all', '--text_file', '/tmp/list.txt', '--vertype', 'lv2', '--keys', '/App/prod.keys',
        ]);
    });
});

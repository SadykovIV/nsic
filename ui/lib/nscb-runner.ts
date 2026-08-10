import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface RunnerEvents {
    progress: { op: string; percent: number; message: string; etaSeconds: number | null; speed: string | null };
    output: { op: string; line: string };
    done: { op: string; code: number };
    error: { op: string; message: string };
}

type EventName = keyof RunnerEvents;
type Listener<K extends EventName> = (value: RunnerEvents[K]) => void;

class Emitter {
    private listeners = new Map<string, Set<Function>>();

    on<K extends EventName>(event: K, listener: Listener<K>): () => void {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(listener);
        return () => { this.listeners.get(event)?.delete(listener); };
    }

    emit<K extends EventName>(event: K, value: RunnerEvents[K]): void {
        this.listeners.get(event)?.forEach((listener) => listener(value));
    }
}

export interface MergeOptions {
    output?: string;
    nodelta?: boolean;
    showFirmware?: boolean;
    rsvcap?: string;
    keypatch?: string;
    tempDir?: string;
}

export interface VerifyOptions {
    vertype?: 'lv1' | 'lv2' | 'lv3';
    filelistPath?: string;
    tempDir?: string;
}

export interface PatchBuildRequest {
    titleId: string;
    basePath: string;
    updatePath: string | null;
    dlcPaths: string[];
    carrierDlcPath: string;
    patchPath: string;
    outputDir: string;
    tempDir: string | null;
    nodelta: boolean;
    showFirmware: boolean;
    rsvcap: string | null;
    keypatch: string | null;
}

export interface ParsedProgress {
    percent: number;
    message: string;
    etaSeconds: number | null;
    speed: string | null;
}

const UNIT_BYTES: Record<string, number> = {
    B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4,
    KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4,
};

function parseEtaSeconds(value: string | undefined): number | null {
    if (!value) return null;
    const match = value.trim().match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/i);
    if (!match || !match[0]) return null;
    return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function progressLabel(line: string): string {
    return line.split('[')[0]?.trim() || line;
}

export function parseProgressLine(line: string): ParsedProgress | null {
    const custom = line.match(/^NSIC_PROGRESS\s+(\d+(?:\.\d+)?)\s*\|\s*(.+)$/);
    if (custom) return { percent: Math.min(99, Number(custom[1])), message: custom[2].trim(), etaSeconds: null, speed: null };

    const details = line.match(/\(([^,()]+\/s),\s*([^)]+)\)/);
    const bytes = Array.from(line.matchAll(/(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)\s*\/\s*(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)/gi)).pop();
    if (bytes) {
        const current = Number(bytes[1]) * UNIT_BYTES[bytes[2].toUpperCase()];
        const total = Number(bytes[3]) * UNIT_BYTES[bytes[4].toUpperCase()];
        if (Number.isFinite(current) && total > 0) {
            return {
                percent: Math.min(/\bDone\b/i.test(line) ? 100 : 99, current / total * 100),
                message: progressLabel(line),
                etaSeconds: parseEtaSeconds(details?.[2]),
                speed: details?.[1]?.trim() ?? null,
            };
        }
    }

    const percent = Array.from(line.matchAll(/(\d+(?:\.\d+)?)\s*%/g)).pop();
    if (percent) return { percent: Math.min(99, Number(percent[1])), message: progressLabel(line), etaSeconds: parseEtaSeconds(details?.[2]), speed: details?.[1]?.trim() ?? null };

    const items = Array.from(line.matchAll(/(?:^|\s)(\d+)\s*\/\s*(\d+)(?:\s|$)/g)).pop();
    if (items && Number(items[2]) > 0) return { percent: Math.min(99, Number(items[1]) / Number(items[2]) * 100), message: progressLabel(line), etaSeconds: null, speed: null };
    return null;
}

export function parseResultLine(line: string): string | null {
    const match = line.match(/^NSIC_RESULT:\s*(.+)$/);
    return match?.[1]?.trim() || null;
}

export function dirname(path: string): string {
    const value = path.replace(/\\/g, '/');
    const index = value.lastIndexOf('/');
    return index >= 0 ? value.slice(0, index) : '.';
}

export function basename(path: string): string {
    return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

export function buildArgs(operation: 'merge' | 'verify', files: string[], options: MergeOptions | VerifyOptions = {}, keysPath: string | null = null): string[] {
    const args: string[] = [];
    if (operation === 'merge') {
        const merge = options as MergeOptions;
        args.push('-d', ...files, '-t', 'xci');
        if (merge.nodelta) args.push('-n');
        if (merge.showFirmware) args.push('--pv');
        if (merge.rsvcap) args.push('--RSVcap', merge.rsvcap);
        if (merge.keypatch) args.push('-k', merge.keypatch);
        args.push('-o', merge.output || dirname(files[0]));
    } else {
        const verify = options as VerifyOptions;
        if (verify.filelistPath) args.push('--verify', 'all', '--text_file', verify.filelistPath);
        else args.push('--verify', ...files);
        args.push('--vertype', verify.vertype ?? 'lv2');
    }
    if (options.tempDir) args.push('--temp-dir', options.tempDir);
    if (keysPath) args.push('--keys', keysPath);
    return args;
}

type StdoutPayload = { op: string; line: string };
type StderrPayload = { op: string; chunk: string };
type DonePayload = { op: string; code: number };

export class NscbRunner extends Emitter {
    private initialized = false;
    private initializing: Promise<void> | null = null;
    private unlisteners: UnlistenFn[] = [];
    private doneResolver: ((code: number) => void) | null = null;
    private active = false;
    private cancelled = false;
    private lastLine = '';
    private patchProgressFloor = 0;
    private resultPath: string | null = null;
    currentOperation: string | null = null;

    async init(): Promise<void> {
        if (this.initialized) return;
        if (this.initializing) return this.initializing;
        this.initializing = (async () => {
            this.unlisteners.push(await listen<StdoutPayload>('nscb-stdout', (event) => this.consume(event.payload.op, event.payload.line, false)));
            this.unlisteners.push(await listen<StderrPayload>('nscb-stderr', (event) => this.consume(event.payload.op, event.payload.chunk, true)));
            this.unlisteners.push(await listen<DonePayload>('nscb-done', (event) => {
                if (event.payload.op !== this.currentOperation) return;
                this.active = false;
                const resolve = this.doneResolver;
                this.doneResolver = null;
                resolve?.(event.payload.code);
            }));
            this.initialized = true;
        })();
        await this.initializing;
        this.initializing = null;
    }

    private normalize(value: string): string {
        return value.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    private consume(op: string, raw: string, isStderr: boolean): void {
        const frames = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '\n').split(/[\r\n]+/).map((value) => this.normalize(value)).filter(Boolean);
        for (const clean of frames) {
            this.lastLine = clean;
            if (op === 'patch') this.resultPath = parseResultLine(clean) ?? this.resultPath;
            const parsed = parseProgressLine(clean);
            if (parsed) {
                if (op === 'patch' && clean.startsWith('NSIC_PROGRESS')) {
                    this.patchProgressFloor = parsed.percent;
                } else if (op === 'patch' && this.patchProgressFloor > 0) {
                    parsed.percent = Math.min(99, this.patchProgressFloor + parsed.percent * (100 - this.patchProgressFloor) / 100);
                }
                this.emit('progress', { op, ...parsed });
            } else this.emit('output', { op, line: clean });
            if (isStderr && /(?:^|\s)(?:error|failed)(?::|\s)/i.test(clean)) this.emit('error', { op, message: clean });
        }
    }

    private async keysPath(): Promise<string | null> {
        try {
            const tools = await invoke<string>('get_tools_dir');
            return `${tools.replace(/\/$/, '')}/prod.keys`;
        } catch { return null; }
    }

    private async start(operation: string, args: string[]): Promise<number> {
        return new Promise<number>(async (resolve) => {
            this.doneResolver = resolve;
            this.active = true;
            try { await invoke('run_nscb', { operation, args }); }
            catch (error) {
                this.active = false;
                this.doneResolver = null;
                this.emit('error', { op: operation, message: String(error) });
                resolve(-1);
            }
        });
    }

    private async startPatch(request: PatchBuildRequest): Promise<number> {
        return new Promise<number>(async (resolve) => {
            this.doneResolver = resolve;
            this.active = true;
            try { await invoke('run_patch_build', { request }); }
            catch (error) {
                this.active = false;
                this.doneResolver = null;
                this.emit('error', { op: 'patch', message: String(error) });
                resolve(-1);
            }
        });
    }

    async run(operation: 'merge' | 'verify', files: string[], options: MergeOptions | VerifyOptions = {}): Promise<number> {
        if (this.active) return -1;
        await this.init();
        this.currentOperation = operation;
        this.cancelled = false;
        this.lastLine = '';

        let finalOptions = options;
        let verificationReport: string | null = null;
        if (operation === 'verify') {
            const list = await invoke<string>('create_verify_filelist', { targetPath: files[0] });
            const listName = basename(list).replace(/\.txt$/i, '');
            verificationReport = `${dirname(list)}/INFO/MASSVERIFY/${listName}-verify.txt`;
            finalOptions = { ...options, filelistPath: list };
        }

        const tempDir = await invoke<string>('get_setting', { key: 'tempDir' }).catch(() => '');
        const args = buildArgs(operation, files, { ...finalOptions, tempDir }, await this.keysPath());
        const display = args.map((arg, index) => args[index - 1] === '--keys' ? '<prod.keys>' : arg);
        this.emit('output', { op: operation, line: `> nscb_rust ${display.join(' ')}` });
        const code = await this.start(operation, args);

        if (operation === 'verify' && verificationReport) {
            try {
                const report = await invoke<string>('read_file_text', { path: verificationReport });
                report.split(/\r?\n/).filter(Boolean).forEach((line) => this.emit('output', { op: operation, line }));
            } catch { /* Backend may stop before producing a report. */ }
        }

        this.currentOperation = null;
        if (this.cancelled) {
            this.emit('done', { op: operation, code: 130 });
            return 130;
        }
        if (code === 0) this.emit('progress', { op: operation, percent: 100, message: 'Done', etaSeconds: 0, speed: null });
        else this.emit('error', { op: operation, message: this.lastLine ? `nscb_rust exited with code ${code}: ${this.lastLine}` : `nscb_rust exited with code ${code}` });
        this.emit('done', { op: operation, code });
        return code;
    }

    async runPatch(request: PatchBuildRequest): Promise<number> {
        if (this.active) return -1;
        await this.init();
        this.currentOperation = 'patch';
        this.cancelled = false;
        this.lastLine = '';
        this.patchProgressFloor = 0;
        this.resultPath = null;
        this.emit('output', { op: 'patch', line: `Patch: ${request.patchPath}` });
        const code = await this.startPatch(request);
        this.currentOperation = null;
        if (this.cancelled) {
            this.emit('done', { op: 'patch', code: 130 });
            return 130;
        }
        if (code === 0) this.emit('progress', { op: 'patch', percent: 100, message: 'Done', etaSeconds: 0, speed: null });
        else this.emit('error', { op: 'patch', message: this.lastLine || `Patch build exited with code ${code}` });
        this.emit('done', { op: 'patch', code });
        return code;
    }

    async cancel(): Promise<void> {
        this.cancelled = true;
        const resolve = this.doneResolver;
        this.doneResolver = null;
        if (this.active) await invoke('cancel_nscb').catch(() => undefined);
        this.active = false;
        this.currentOperation = null;
        resolve?.(130);
    }

    isRunning(): boolean { return this.active; }
    getResultPath(): string | null { return this.resultPath; }
}

let runner: NscbRunner | null = null;
export function getRunner(): NscbRunner { runner ??= new NscbRunner(); return runner; }

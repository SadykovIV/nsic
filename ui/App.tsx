import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import * as api from './lib/api';
import {
    analyzeInventory,
    findBuiltXci,
    formatBytes,
    formatDuration,
    type ContentKind,
    type SelectedSwitchFile,
} from './lib/inventory';
import { dirname, getRunner } from './lib/nscb-runner';

type Language = 'ru' | 'en';
type View = 'builder' | 'settings' | 'about';
type RunStatus = 'idle' | 'running' | 'success' | 'error' | 'cancelled';

const TEXT = {
    ru: {
        subtitle: 'Создание проверяемых XCI-образов для MeloNX — локально и без изменения исходных файлов',
        settings: 'Настройки', about: 'О программе', back: 'Назад к сборке',
        sourceTitle: '1. Исходные файлы игры', chooseFiles: 'Выбрать файлы…', chooseFolder: 'Выбрать папку…',
        clear: 'Очистить', scanHint: 'Перетащите сюда base, update и DLC', scanFormats: 'NSP · NSZ · XCI · XCZ',
        scanEmpty: 'Поддерживаемые файлы не найдены', scanning: 'Сканирование…',
        storageTitle: '2. Папки хранения', outputLabel: 'Готовые XCI', tempLabel: 'Временные файлы',
        choose: 'Выбрать…', systemDefault: 'Системная папка по умолчанию',
        inventoryTitle: '3. Состав XCI', selected: 'Выбрано', type: 'Тип', file: 'Файл', titleId: 'TITLE ID', version: 'Версия', size: 'Размер',
        base: 'BASE', update: 'UPDATE', dlc: 'DLC', unknown: 'НЕ ОПРЕДЕЛЁН',
        summary: 'Файлов: {count} · base: {base} · update: {update} · DLC: {dlc} · ≈ {size}',
        noFiles: 'Добавьте хотя бы один файл игры.', noBase: 'Найдены только update/DLC. Добавьте базовую игру.',
        multipleTitles: 'В наборе обнаружено несколько базовых TITLE ID. Собирайте каждую игру отдельно.',
        unknownContent: 'Тип части некоторых файлов не определён по имени. Проверьте набор вручную.',
        multipleUpdates: 'Выбрано несколько обновлений. Backend определит применимое, но лучше оставить только самое новое.',
        conflictingEntitlements: 'Full Game DLC 010092A0172E5001 и Friends Pass 010092A0172E5002 — взаимоисключающие права It Takes Two. Для полной игры оставьте только 010092A0172E5001.',
        patchTitle: 'Встраиваемая модификация (необязательно)', patchChoose: 'Выбрать папку русификатора…', patchRemove: 'Убрать',
        patchHint: 'Безопасный режим для Unreal Engine: PAK/UTOC/UCAS из <TITLE ID>/romfs встраиваются в выбранный DLC-плагин. Base и update не пересобираются.',
        patchSummary: 'TITLE ID {titleId} · файлов: {count} · {size}', patchMismatch: 'TITLE ID модификации не совпадает с базовой игрой.',
        carrierLabel: 'DLC-контейнер модификации', carrierChoose: 'Выберите совместимый DLC…',
        carrierMissing: 'Для модификации выберите DLC-контейнер. Он должен содержать Unreal-плагин (.uplugin и штатный .pak).',
        patchToolsMissing: 'Для встраивания нужны hactool и hacPack. Импортируйте их в настройках.',
        patchToolsTitle: 'Инструменты встраивания', patchToolsBody: 'hactool извлекает выбранный DLC, hacPack пересобирает только его PublicData и Meta NCA. Base, update и остальные DLC сохраняются исходными. Утилиты не входят в релиз NSIC.',
        importHactool: 'Импортировать hactool…', importHacpack: 'Импортировать hacPack…',
        tempUnused: 'Для выбранных NSP/XCI backend работает потоково; временная папка может остаться пустой.',
        tempCompressed: 'NSZ/XCZ будут распакованы через временную папку.',
        tempPatch: 'Модификация включена: временная папка будет использована для распаковки и пересборки выбранного DLC-контейнера.',
        optionsTitle: '4. Параметры сборки', noDelta: 'Исключить delta-фрагменты', noDeltaHelp: 'Обычно они не нужны в объединённом XCI и увеличивают размер.',
        verify: 'Проверить XCI после сборки', verifyHelp: 'Проверка расшифровки и исходных подписей. Она не гарантирует запуск конкретной игры в MeloNX.',
        verifyPatchedHelp: 'Обязательная проверка IVFC PublicData выполняется внутри сборки. Общая проверка подписей неприменима: выбранный DLC намеренно модифицирован.',
        firmwareInfo: 'Показать сведения о требуемой прошивке', advanced: 'Расширенные параметры прошивки',
        rsvCap: 'Ограничение RSV', keyPatch: 'Поколение ключа', optional: 'Не изменять',
        firmwareWarning: 'Меняйте эти значения только при точном понимании исходного key generation. Неверный параметр может сделать образ неработоспособным.',
        log: 'Журнал', clearLog: 'Очистить журнал', ready: 'Готово к сборке', elapsed: 'Прошло {time}', eta: 'осталось ≈ {time}', etaUnknown: 'осталось —',
        build: 'Собрать XCI', cancel: 'Отменить', openOutput: 'Открыть папку результата',
        buildStarting: 'Подготовка сборки…', mergeStage: 'Создание XCI…', verifyStage: 'Проверка готового XCI…',
        complete: 'XCI успешно собран{verified}.', verified: ' и проверен', failed: 'Сборка завершилась с ошибкой.', cancelled: 'Операция отменена.',
        resultNotFound: 'Backend завершил сборку, но NSIC не смог определить новый XCI в папке результата.',
        prerequisites: 'Для сборки требуются два локальных компонента', keysReady: 'prod.keys импортирован', keysMissing: 'prod.keys не настроен',
        backendReady: 'nscb_rust установлен', backendMissing: 'nscb_rust не установлен', configure: 'Настроить',
        settingsTitle: 'Настройки NSIC', settingsSubtitle: 'Ключи, backend и временное хранилище',
        keysTitle: 'Ключи шифрования', keysBody: 'NSIC использует только ваш локальный prod.keys. Содержимое ключей не записывается в журнал и не отправляется по сети.',
        importKeys: 'Импортировать prod.keys…', replaceKeys: 'Заменить prod.keys…', removeKeys: 'Удалить из NSIC',
        backendTitle: 'Backend сборки', backendBody: 'nscb_rust запускается как отдельная утилита. Он не входит в исходники или релиз NSIC.',
        downloadBackend: 'Скачать с GitHub автора', importBackend: 'Импортировать вручную…', checkingRelease: 'Проверка релиза…',
        backendVersion: 'Установлено: {version}', manualVersion: 'Установлено вручную', unavailable: 'Релиз для macOS ARM64 не найден',
        tempTitle: 'Временная папка', tempBody: 'Для больших игр выберите диск, где свободного места не меньше размера исходного набора.',
        reset: 'Сбросить', dataTitle: 'Данные приложения', dataBody: 'Здесь NSIC хранит настройки, импортированный ключ и внешний backend.', openData: 'Открыть папку NSIC',
        setupError: 'Не удалось обновить настройку: {error}', downloadProgress: 'Загрузка backend…', downloadDone: 'Backend установлен.',
        aboutTitle: 'Nintendo Switch Image Converter', aboutBody: 'NSIC — интерфейс для локальной сборки base, update и DLC в единый XCI с опциональной проверкой результата.',
        designNote: 'Интерфейс следует логике PS4 FFPFSC: источник → состав → параметры → проверяемый результат.',
        buildIdentity: 'Safe DLC',
        legalTitle: 'Границы проекта', legalBody: 'NSIC не скачивает игры или ключи и не включает их в дистрибутив. Используйте только собственные законно полученные дампы и ключи. Совместимость с MeloNX не гарантируется.',
        sourcesTitle: 'Технологическая основа', sourceNscb: 'nscb_rust — внешний backend', sourceBuilder: 'NSC_Builder — исходная концепция workflow', sourceNsz: 'NSZ — формат и инструменты сжатия',
        unsupportedDrop: 'В выбранном источнике нет файлов NSP, NSZ, XCI или XCZ.',
    },
    en: {
        subtitle: 'Build verifiable XCI images for MeloNX locally without modifying source files',
        settings: 'Settings', about: 'About', back: 'Back to builder',
        sourceTitle: '1. Game source files', chooseFiles: 'Choose files…', chooseFolder: 'Choose folder…',
        clear: 'Clear', scanHint: 'Drop base, update and DLC here', scanFormats: 'NSP · NSZ · XCI · XCZ',
        scanEmpty: 'No supported files found', scanning: 'Scanning…',
        storageTitle: '2. Storage folders', outputLabel: 'Completed XCI files', tempLabel: 'Temporary files',
        choose: 'Choose…', systemDefault: 'System default temporary folder',
        inventoryTitle: '3. XCI contents', selected: 'Selected', type: 'Type', file: 'File', titleId: 'TITLE ID', version: 'Version', size: 'Size',
        base: 'BASE', update: 'UPDATE', dlc: 'DLC', unknown: 'UNKNOWN',
        summary: 'Files: {count} · base: {base} · update: {update} · DLC: {dlc} · ≈ {size}',
        noFiles: 'Add at least one game file.', noBase: 'Only update/DLC content was found. Add the base game.',
        multipleTitles: 'More than one base TITLE ID was found. Build each game separately.',
        unknownContent: 'Some content types cannot be inferred from filenames. Review the set manually.',
        multipleUpdates: 'Multiple updates are selected. The backend will choose applicable content, but keeping only the newest is safer.',
        conflictingEntitlements: 'Full Game DLC 010092A0172E5001 and Friends Pass 010092A0172E5002 are mutually exclusive It Takes Two entitlements. Keep only 010092A0172E5001 for the full game.',
        patchTitle: 'Embedded modification (optional)', patchChoose: 'Choose localization folder…', patchRemove: 'Remove',
        patchHint: 'Safe Unreal Engine mode: PAK/UTOC/UCAS assets from <TITLE ID>/romfs are embedded into a selected DLC plugin. Base and update are not rebuilt.',
        patchSummary: 'TITLE ID {titleId} · files: {count} · {size}', patchMismatch: 'The modification TITLE ID does not match the base game.',
        carrierLabel: 'Modification DLC carrier', carrierChoose: 'Choose a compatible DLC…',
        carrierMissing: 'Select a DLC carrier for the modification. It must contain an Unreal plugin (.uplugin plus an original .pak).',
        patchToolsMissing: 'Embedding requires hactool and hacPack. Import them in Settings.',
        patchToolsTitle: 'Embedding tools', patchToolsBody: 'hactool extracts the selected DLC and hacPack rebuilds only its PublicData and Meta NCAs. Base, update and other DLC stay original. Neither tool is bundled with NSIC.',
        importHactool: 'Import hactool…', importHacpack: 'Import hacPack…',
        tempUnused: 'The selected NSP/XCI files are streamed; the temporary folder may remain empty.',
        tempCompressed: 'NSZ/XCZ inputs will be decompressed through the temporary folder.',
        tempPatch: 'A modification is enabled: the temporary folder will hold the extracted and rebuilt DLC carrier.',
        optionsTitle: '4. Build options', noDelta: 'Exclude delta fragments', noDeltaHelp: 'They are normally unnecessary in a merged XCI and increase its size.',
        verify: 'Verify XCI after building', verifyHelp: 'Checks decryption and original signatures. It cannot guarantee that a particular game launches in MeloNX.',
        verifyPatchedHelp: 'Mandatory PublicData IVFC verification runs inside the build. General signature verification is not applicable because the selected DLC is intentionally modified.',
        firmwareInfo: 'Show required firmware information', advanced: 'Advanced firmware controls',
        rsvCap: 'RSV cap', keyPatch: 'Key generation', optional: 'Do not change',
        firmwareWarning: 'Only set these values when you know the source key generation. A wrong value can make the image unusable.',
        log: 'Log', clearLog: 'Clear log', ready: 'Ready to build', elapsed: 'Elapsed {time}', eta: 'remaining ≈ {time}', etaUnknown: 'remaining —',
        build: 'Build XCI', cancel: 'Cancel', openOutput: 'Open output folder',
        buildStarting: 'Preparing build…', mergeStage: 'Building XCI…', verifyStage: 'Verifying completed XCI…',
        complete: 'XCI built{verified} successfully.', verified: ' and verified', failed: 'The build failed.', cancelled: 'Operation cancelled.',
        resultNotFound: 'The backend completed, but NSIC could not identify a new XCI in the output folder.',
        prerequisites: 'Two local components are required', keysReady: 'prod.keys imported', keysMissing: 'prod.keys is not configured',
        backendReady: 'nscb_rust installed', backendMissing: 'nscb_rust is not installed', configure: 'Configure',
        settingsTitle: 'NSIC settings', settingsSubtitle: 'Keys, backend and temporary storage',
        keysTitle: 'Encryption keys', keysBody: 'NSIC uses only your local prod.keys. Key contents are never written to logs or sent over the network.',
        importKeys: 'Import prod.keys…', replaceKeys: 'Replace prod.keys…', removeKeys: 'Remove from NSIC',
        backendTitle: 'Build backend', backendBody: 'nscb_rust runs as a separate tool. It is not included in NSIC source code or releases.',
        downloadBackend: 'Download from author’s GitHub', importBackend: 'Import manually…', checkingRelease: 'Checking release…',
        backendVersion: 'Installed: {version}', manualVersion: 'Installed manually', unavailable: 'No macOS ARM64 release found',
        tempTitle: 'Temporary folder', tempBody: 'For large games, select a disk with at least as much free space as the source set.',
        reset: 'Reset', dataTitle: 'Application data', dataBody: 'NSIC stores settings, the imported key and the external backend here.', openData: 'Open NSIC folder',
        setupError: 'Could not update setting: {error}', downloadProgress: 'Downloading backend…', downloadDone: 'Backend installed.',
        aboutTitle: 'Nintendo Switch Image Converter', aboutBody: 'NSIC is a local interface for building base, update and DLC content into one XCI with optional verification.',
        designNote: 'The UI follows PS4 FFPFSC: source → contents → options → verifiable result.',
        buildIdentity: 'Safe DLC',
        legalTitle: 'Project boundaries', legalBody: 'NSIC does not download games or keys and never bundles them. Use only your own legally obtained dumps and keys. MeloNX compatibility is not guaranteed.',
        sourcesTitle: 'Technical foundation', sourceNscb: 'nscb_rust — external backend', sourceBuilder: 'NSC_Builder — original workflow concept', sourceNsz: 'NSZ — compression format and tools',
        unsupportedDrop: 'The selected source contains no NSP, NSZ, XCI or XCZ files.',
    },
} as const;

type TextKey = keyof typeof TEXT.ru;
const runner = getRunner();

function Icon({ name, size = 18 }: { name: 'file' | 'folder' | 'settings' | 'info' | 'play' | 'stop' | 'trash' | 'key' | 'tool' | 'open' | 'check' | 'warning'; size?: number }) {
    const paths: Record<typeof name, React.ReactNode> = {
        file: <><path d="M14 2H6a2 2 0 0 0-2 2v16h16V8z"/><path d="M14 2v6h6"/></>,
        folder: <path d="M3 5h7l2 2h9v12H3z"/>,
        settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z"/></>,
        info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></>,
        play: <path d="m8 5 11 7-11 7z"/>, stop: <rect x="6" y="6" width="12" height="12" rx="1"/>,
        trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></>,
        key: <><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l2 2M14 9l2 2"/></>,
        tool: <><path d="M14 6a4 4 0 0 0-5 5L3 17l4 4 6-6a4 4 0 0 0 5-5l-3 3-4-4z"/></>,
        open: <><path d="M4 5h7l2 2h7v12H4z"/><path d="m13 11 3-3 3 3M16 8v7"/></>,
        check: <path d="m5 12 4 4 10-10"/>,
        warning: <><path d="M12 3 2.5 20h19z"/><path d="M12 9v4M12 17h.01"/></>,
    };
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function interpolate(value: string, fields: Record<string, string | number>): string {
    return Object.entries(fields).reduce((result, [key, replacement]) => result.replace(`{${key}}`, String(replacement)), value);
}

export default function App() {
    const [language, setLanguage] = useState<Language>('ru');
    const [view, setView] = useState<View>('builder');
    const [version, setVersion] = useState('0.2');
    const [files, setFiles] = useState<SelectedSwitchFile[]>([]);
    const [outputDir, setOutputDir] = useState('');
    const [tempDir, setTempDir] = useState('');
    const [keysReady, setKeysReady] = useState(false);
    const [backendReady, setBackendReady] = useState(false);
    const [patchTools, setPatchTools] = useState<api.PatchToolStatus>({ hactool: false, hacpack: false });
    const [patch, setPatch] = useState<api.PatchInspection | null>(null);
    const [carrierDlcPath, setCarrierDlcPath] = useState('');
    const [backendVersion, setBackendVersion] = useState('');
    const [toolsDir, setToolsDir] = useState('');
    const [release, setRelease] = useState<api.BackendRelease | null>(null);
    const [releaseChecked, setReleaseChecked] = useState(false);
    const [setupMessage, setSetupMessage] = useState('');
    const [scanning, setScanning] = useState(false);
    const [dragActive, setDragActive] = useState(false);
    const [noDelta, setNoDelta] = useState(true);
    const [verifyResult, setVerifyResult] = useState(true);
    const [showFirmware, setShowFirmware] = useState(true);
    const [rsvCap, setRsvCap] = useState('');
    const [keyPatch, setKeyPatch] = useState('');
    const [running, setRunning] = useState(false);
    const [runStatus, setRunStatus] = useState<RunStatus>('idle');
    const [phase, setPhase] = useState('');
    const [progress, setProgress] = useState(0);
    const [backendEta, setBackendEta] = useState<number | null>(null);
    const [backendSpeed, setBackendSpeed] = useState<string | null>(null);
    const [logs, setLogs] = useState<string[]>([]);
    const [resultPath, setResultPath] = useState('');
    const [startedAt, setStartedAt] = useState<number | null>(null);
    const [lastElapsed, setLastElapsed] = useState(0);
    const [now, setNow] = useState(Date.now());
    const logEnd = useRef<HTMLDivElement>(null);
    const t = useCallback((key: TextKey) => TEXT[language][key], [language]);

    const refreshTools = useCallback(async () => {
        const [keys, backend, installedVersion, directory, patchStatus] = await Promise.all([
            api.hasKeys(), api.hasBackend(), api.getBackendVersion(), api.getToolsDirectory().catch(() => ''), api.getPatchToolStatus(),
        ]);
        setKeysReady(keys);
        setBackendReady(backend);
        setPatchTools(patchStatus);
        setBackendVersion(installedVersion);
        setToolsDir(directory);
    }, []);

    const addPaths = useCallback(async (paths: string[]) => {
        if (paths.length === 0) return;
        setScanning(true);
        try {
            const inspected = await api.inspectPaths(paths, true);
            if (inspected.length === 0) setSetupMessage(TEXT[language].unsupportedDrop);
            else {
                setSetupMessage('');
                setFiles((current) => {
                    const merged = new Map(current.map((file) => [file.path, file]));
                    inspected.forEach((file) => merged.set(file.path, { ...file, selected: merged.get(file.path)?.selected ?? true }));
                    return Array.from(merged.values());
                });
                setOutputDir((current) => current || dirname(inspected[0].path));
            }
        } catch (error) {
            setSetupMessage(String(error));
        } finally {
            setScanning(false);
        }
    }, [language]);

    useEffect(() => {
        void Promise.all([
            api.getSetting('language'), api.getSetting('outputDir'), api.getSetting('tempDir'), getVersion().catch(() => '0.2'),
        ]).then(([savedLanguage, savedOutput, savedTemp, appVersion]) => {
            if (savedLanguage === 'en' || savedLanguage === 'ru') setLanguage(savedLanguage);
            setOutputDir(savedOutput);
            setTempDir(savedTemp);
            setVersion(appVersion === '0.2.0' ? '0.2' : appVersion);
        });
        void runner.init();
        void refreshTools();
        void api.fetchLatestBackendRelease().then((value) => {
            setRelease(value);
            setReleaseChecked(true);
        });

        const unsubscribeOutput = runner.on('output', ({ op, line }) => {
            setLogs((current) => [...current.slice(-999), `[${op}] ${line}`]);
        });
        const unsubscribeProgress = runner.on('progress', ({ percent, message, etaSeconds, speed }) => {
            setProgress(percent);
            setBackendEta(etaSeconds);
            setBackendSpeed(speed);
            if (message) setPhase(message);
        });
        const unsubscribeError = runner.on('error', ({ message }) => {
            setLogs((current) => [...current.slice(-999), `ERROR: ${message}`]);
        });

        const dropUnlisten = getCurrentWebviewWindow().onDragDropEvent((event) => {
            if (event.payload.type === 'enter' || event.payload.type === 'over') setDragActive(true);
            if (event.payload.type === 'leave') setDragActive(false);
            if (event.payload.type === 'drop') {
                setDragActive(false);
                void addPaths(event.payload.paths);
            }
        });
        return () => {
            unsubscribeOutput();
            unsubscribeProgress();
            unsubscribeError();
            void dropUnlisten.then((unlisten) => unlisten());
        };
    }, [addPaths, refreshTools]);

    useEffect(() => {
        if (!running) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [running]);

    useEffect(() => {
        logEnd.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);

    useEffect(() => {
        if (outputDir) void api.saveSetting('outputDir', outputDir);
    }, [outputDir]);

    const analysis = useMemo(() => analyzeInventory(files), [files]);
    const selectedDlcs = useMemo(
        () => files.filter((file) => file.selected && file.kind === 'dlc'),
        [files],
    );

    useEffect(() => {
        if (!patch) {
            if (carrierDlcPath) setCarrierDlcPath('');
            return;
        }
        if (selectedDlcs.some((file) => file.path === carrierDlcPath)) return;
        setCarrierDlcPath(selectedDlcs.length === 1 ? selectedDlcs[0].path : '');
    }, [patch, selectedDlcs, carrierDlcPath]);

    const elapsed = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : lastElapsed;
    const hasMixedTitles = analysis.warnings.includes('multiple_titles');
    const hasConflictingEntitlements = analysis.warnings.includes('conflicting_entitlements');
    const patchMatches = !patch || analysis.baseTitleIds.includes(patch.titleId);
    const patchToolsReady = patchTools.hactool && patchTools.hacpack;
    const carrierReady = !patch || Boolean(carrierDlcPath);
    const canBuild = !running && !analysis.blockingError && !hasMixedTitles && !hasConflictingEntitlements && patchMatches && carrierReady && Boolean(outputDir) && keysReady && backendReady && (!patch || patchToolsReady);
    const selectedCompressed = files.some((file) => file.selected && (file.extension === 'nsz' || file.extension === 'xcz'));
    const tempExplanation = patch ? t('tempPatch') : selectedCompressed ? t('tempCompressed') : t('tempUnused');

    const changeLanguage = (next: Language) => {
        setLanguage(next);
        void api.saveSetting('language', next);
    };

    const chooseFiles = async () => addPaths(await api.selectSwitchFiles());
    const chooseFolder = async () => {
        const directory = await api.selectDirectory(t('sourceTitle'));
        if (directory) await addPaths([directory]);
    };
    const chooseOutput = async () => {
        const directory = await api.selectDirectory(t('outputLabel'));
        if (directory) setOutputDir(directory);
    };
    const chooseTemp = async () => {
        const directory = await api.selectDirectory(t('tempLabel'));
        if (!directory) return;
        setTempDir(directory);
        await api.saveSetting('tempDir', directory);
    };
    const choosePatch = async () => {
        try {
            const selected = await api.selectAndInspectPatch(t('patchTitle'));
            if (selected) { setPatch(selected); setSetupMessage(selected.warnings.join(' · ')); }
        } catch (error) { setSetupMessage(String(error)); }
    };
    const importPatchTool = async (kind: 'hactool' | 'hacpack') => {
        const result = await api.importPatchTool(kind);
        if (result.error) setSetupMessage(interpolate(t('setupError'), { error: result.error }));
        await refreshTools();
    };

    const resetRun = () => {
        setFiles([]);
        setPatch(null);
        setCarrierDlcPath('');
        setLogs([]);
        setProgress(0);
        setRunStatus('idle');
        setPhase('');
        setBackendEta(null);
        setBackendSpeed(null);
        setResultPath('');
        setLastElapsed(0);
        setStartedAt(null);
    };

    const startBuild = async () => {
        if (!canBuild) return;
        const selectedFiles = files.filter((file) => file.selected).map((file) => file.path);
        const timestamp = Date.now();
        setStartedAt(timestamp);
        setNow(timestamp);
        setLastElapsed(0);
        setRunning(true);
        setRunStatus('running');
        setProgress(0);
        setBackendEta(null);
        setBackendSpeed(null);
        setPhase(t('buildStarting'));
        setLogs([]);
        setResultPath('');

        const before = await api.inspectPaths([outputDir], false).catch(() => []);
        let mergeCode: number;
        if (patch) {
            const selected = files.filter((file) => file.selected);
            const base = selected.find((file) => file.kind === 'base');
            const updates = selected.filter((file) => file.kind === 'update').sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
            if (!base) { setRunStatus('error'); setPhase(t('noBase')); finishTiming(timestamp); return; }
            mergeCode = await runner.runPatch({
                titleId: patch.titleId, basePath: base.path, updatePath: updates[0]?.path ?? null,
                dlcPaths: selected.filter((file) => file.kind === 'dlc').map((file) => file.path),
                carrierDlcPath, patchPath: patch.root,
                outputDir, tempDir: tempDir || null, nodelta: noDelta, showFirmware,
                rsvcap: rsvCap.trim() || null, keypatch: keyPatch.trim() || null,
            });
        } else {
            setPhase(t('mergeStage'));
            mergeCode = await runner.run('merge', selectedFiles, {
                output: outputDir, nodelta: noDelta, showFirmware,
                rsvcap: rsvCap.trim() || undefined, keypatch: keyPatch.trim() || undefined,
            });
        }

        if (mergeCode === 130) {
            setRunStatus('cancelled');
            setPhase(t('cancelled'));
            finishTiming(timestamp);
            return;
        }
        if (mergeCode !== 0) {
            setRunStatus('error');
            setPhase(t('failed'));
            finishTiming(timestamp);
            return;
        }

        const after = await api.inspectPaths([outputDir], false).catch(() => []);
        const exactResultPath = runner.getResultPath();
        const exactResult = exactResultPath
            ? (await api.inspectPaths([exactResultPath], false).catch(() => []))[0] ?? null
            : null;
        const built = exactResult ?? findBuiltXci(before, after, timestamp);
        if (built) setResultPath(built.path);
        if (!built) setLogs((current) => [...current, `WARNING: ${t('resultNotFound')}`]);

        let verified = Boolean(patch && built);
        if (verifyResult && built && !patch) {
            setProgress(0);
            setBackendEta(null);
            setBackendSpeed(null);
            setPhase(t('verifyStage'));
            const verifyCode = await runner.run('verify', [built.path], { vertype: 'lv2' });
            if (verifyCode === 130) {
                setRunStatus('cancelled');
                setPhase(t('cancelled'));
                finishTiming(timestamp);
                return;
            }
            if (verifyCode !== 0) {
                setRunStatus('error');
                setPhase(t('failed'));
                finishTiming(timestamp);
                return;
            }
            verified = true;
        }

        setProgress(100);
        setRunStatus('success');
        setPhase(interpolate(t('complete'), { verified: verified ? t('verified') : '' }));
        finishTiming(timestamp);
    };

    const finishTiming = (timestamp: number) => {
        setLastElapsed(Math.max(0, Math.floor((Date.now() - timestamp) / 1000)));
        setStartedAt(null);
        setRunning(false);
    };

    const cancelBuild = async () => {
        await runner.cancel();
        setRunStatus('cancelled');
        setPhase(t('cancelled'));
        if (startedAt) setLastElapsed(Math.floor((Date.now() - startedAt) / 1000));
        setStartedAt(null);
        setRunning(false);
    };

    const importKeys = async () => {
        const result = await api.importKeys();
        if (result.error) setSetupMessage(interpolate(t('setupError'), { error: result.error }));
        await refreshTools();
    };
    const removeKeys = async () => {
        await api.removeKeys();
        await refreshTools();
    };
    const importBackend = async () => {
        const result = await api.importBackend();
        if (result.error) setSetupMessage(interpolate(t('setupError'), { error: result.error }));
        await refreshTools();
    };
    const downloadBackend = async () => {
        if (!release) return;
        setSetupMessage(t('downloadProgress'));
        try {
            await api.downloadBackend(release);
            setSetupMessage(t('downloadDone'));
            await refreshTools();
        } catch (error) {
            setSetupMessage(interpolate(t('setupError'), { error: String(error) }));
        }
    };

    const header = (
        <header className="app-header">
            <div className="brand-mark" aria-hidden="true">NS</div>
            <div className="brand-copy">
                <h1>Nintendo Switch Image Converter <span>NSIC</span></h1>
                <p>{t('subtitle')}</p>
            </div>
            <div className="header-actions">
                <select className="language-select" value={language} onChange={(event) => changeLanguage(event.target.value as Language)} aria-label="Language">
                    <option value="ru">Русский</option>
                    <option value="en">English</option>
                </select>
                {view === 'builder' ? <>
                    <button className="button quiet" onClick={() => setView('settings')}><Icon name="settings" />{t('settings')}</button>
                    <button className="button quiet" onClick={() => setView('about')}><Icon name="info" />{t('about')}</button>
                </> : <button className="button quiet" onClick={() => setView('builder')}>{t('back')}</button>}
            </div>
        </header>
    );

    if (view === 'settings') {
        return <div className="app-shell">{header}<main className="settings-page">
            <div className="page-heading"><h2>{t('settingsTitle')}</h2><p>{t('settingsSubtitle')}</p></div>
            {setupMessage && <div className="notice info"><Icon name="info" />{setupMessage}</div>}
            <section className="card settings-card">
                <div className="settings-icon"><Icon name="key" size={22} /></div>
                <div className="settings-copy"><h3>{t('keysTitle')}</h3><p>{t('keysBody')}</p><span className={`status-pill ${keysReady ? 'ok' : 'missing'}`}>{keysReady ? t('keysReady') : t('keysMissing')}</span></div>
                <div className="settings-actions"><button className="button secondary" onClick={importKeys}>{keysReady ? t('replaceKeys') : t('importKeys')}</button>{keysReady && <button className="button danger" onClick={removeKeys}>{t('removeKeys')}</button>}</div>
            </section>
            <section className="card settings-card">
                <div className="settings-icon"><Icon name="tool" size={22} /></div>
                <div className="settings-copy"><h3>{t('backendTitle')}</h3><p>{t('backendBody')}</p><span className={`status-pill ${backendReady ? 'ok' : 'missing'}`}>{backendReady ? (backendVersion ? interpolate(t('backendVersion'), { version: backendVersion }) : t('manualVersion')) : t('backendMissing')}</span></div>
                <div className="settings-actions">
                    <button className="button primary" disabled={!release || backendReady} onClick={downloadBackend}>{!releaseChecked ? t('checkingRelease') : release ? t('downloadBackend') : t('unavailable')}</button>
                    <button className="button secondary" onClick={importBackend}>{t('importBackend')}</button>
                </div>
            </section>
            <section className="card settings-card">
                <div className="settings-icon"><Icon name="tool" size={22} /></div>
                <div className="settings-copy"><h3>{t('patchToolsTitle')}</h3><p>{t('patchToolsBody')}</p><span className={`status-pill ${patchToolsReady ? 'ok' : 'missing'}`}>hactool: {patchTools.hactool ? 'OK' : '—'} · hacPack: {patchTools.hacpack ? 'OK' : '—'}</span></div>
                <div className="settings-actions"><button className="button secondary" onClick={() => importPatchTool('hactool')}>{t('importHactool')}</button><button className="button secondary" onClick={() => importPatchTool('hacpack')}>{t('importHacpack')}</button></div>
            </section>
            <section className="card settings-card">
                <div className="settings-icon"><Icon name="folder" size={22} /></div>
                <div className="settings-copy"><h3>{t('tempTitle')}</h3><p>{t('tempBody')}</p><code className="path-box">{tempDir || t('systemDefault')}</code></div>
                <div className="settings-actions"><button className="button secondary" onClick={chooseTemp}>{t('choose')}</button>{tempDir && <button className="button quiet" onClick={() => { setTempDir(''); void api.saveSetting('tempDir', ''); }}>{t('reset')}</button>}</div>
            </section>
            <section className="card settings-card">
                <div className="settings-icon"><Icon name="open" size={22} /></div>
                <div className="settings-copy"><h3>{t('dataTitle')}</h3><p>{t('dataBody')}</p><code className="path-box">{toolsDir || '—'}</code></div>
                <div className="settings-actions"><button className="button secondary" disabled={!toolsDir} onClick={() => api.revealPath(toolsDir)}>{t('openData')}</button></div>
            </section>
        </main></div>;
    }

    if (view === 'about') {
        return <div className="app-shell">{header}<main className="about-page">
            <section className="about-hero card"><div className="about-logo">NS</div><h2>{t('aboutTitle')}</h2><div className="version">v{version} · macOS ARM64 · {t('buildIdentity')}</div><p>{t('aboutBody')}</p><p>{t('designNote')}</p></section>
            <section className="card about-section"><h3>{t('legalTitle')}</h3><p>{t('legalBody')}</p></section>
            <section className="card about-section"><h3>{t('sourcesTitle')}</h3><div className="source-links">
                <button onClick={() => api.openExternal('https://github.com/cxfcxf/nscb_rust')}>{t('sourceNscb')}</button>
                <button onClick={() => api.openExternal('https://github.com/julesontheroad/NSC_BUILDER')}>{t('sourceBuilder')}</button>
                <button onClick={() => api.openExternal('https://github.com/nicoboss/nsz')}>{t('sourceNsz')}</button>
            </div></section>
        </main></div>;
    }

    const warningMessages = analysis.warnings.map((warning) => ({
        multiple_titles: t('multipleTitles'), unknown_content: t('unknownContent'), multiple_updates: t('multipleUpdates'), conflicting_entitlements: t('conflictingEntitlements'),
    }[warning]));
    const blockingMessage = analysis.blockingError === 'no_base' ? t('noBase') : analysis.blockingError === 'no_files' ? t('noFiles') : '';

    return <div className="app-shell">{header}<main className="builder-page">
        {(!keysReady || !backendReady) && <div className="setup-banner">
            <div><strong>{t('prerequisites')}</strong><div className="setup-statuses"><span className={keysReady ? 'ready' : ''}><Icon name={keysReady ? 'check' : 'warning'} />{keysReady ? t('keysReady') : t('keysMissing')}</span><span className={backendReady ? 'ready' : ''}><Icon name={backendReady ? 'check' : 'warning'} />{backendReady ? t('backendReady') : t('backendMissing')}</span></div></div>
            <button className="button secondary" onClick={() => setView('settings')}>{t('configure')}</button>
        </div>}
        {setupMessage && <div className="notice info"><Icon name="info" />{setupMessage}</div>}

        <section className="card source-card">
            <div className="section-heading"><h2>{t('sourceTitle')}</h2><div className="section-actions"><button className="button secondary" onClick={chooseFiles}><Icon name="file" />{t('chooseFiles')}</button><button className="button secondary" onClick={chooseFolder}><Icon name="folder" />{t('chooseFolder')}</button><button className="button quiet" disabled={files.length === 0 || running} onClick={resetRun}>{t('clear')}</button></div></div>
            <button className={`drop-zone ${dragActive ? 'active' : ''}`} onClick={chooseFiles} disabled={running}>
                <Icon name="open" size={34} /><strong>{scanning ? t('scanning') : t('scanHint')}</strong><span>{t('scanFormats')}</span>
            </button>
        </section>

        <section className="card source-card patch-card">
            <div className="section-heading"><h2>{t('patchTitle')}</h2><div className="section-actions"><button className="button secondary" disabled={running} onClick={choosePatch}><Icon name="folder" />{t('patchChoose')}</button>{patch && <button className="button quiet" disabled={running} onClick={() => setPatch(null)}>{t('patchRemove')}</button>}</div></div>
            <p className="patch-hint">{t('patchHint')}</p>
            {patch && <div className="patch-summary"><code>{patch.contentRoot}</code><strong>{interpolate(t('patchSummary'), { titleId: patch.titleId, count: patch.fileCount, size: formatBytes(patch.totalSize) })}</strong></div>}
            {patch && <label className="carrier-picker"><span>{t('carrierLabel')}</span><select value={carrierDlcPath} disabled={running} onChange={(event) => setCarrierDlcPath(event.target.value)}><option value="">{t('carrierChoose')}</option>{selectedDlcs.map((file) => <option value={file.path} key={file.path}>{file.name} · {file.titleId || '—'}</option>)}</select></label>}
            {patch && !patchMatches && <div className="notice error"><Icon name="warning" />{t('patchMismatch')}</div>}
            {patch && !carrierReady && <div className="notice warning"><Icon name="warning" />{t('carrierMissing')}</div>}
            {patch && !patchToolsReady && <div className="notice warning"><Icon name="warning" />{t('patchToolsMissing')}</div>}
        </section>

        <section className="card storage-card">
            <h2>{t('storageTitle')}</h2>
            <div className="storage-grid"><label><span>{t('outputLabel')}</span><div className="path-row"><code>{outputDir || '—'}</code><button className="button secondary" onClick={chooseOutput}>{t('choose')}</button></div></label><label><span>{t('tempLabel')}</span><div className="path-row"><code>{tempDir || t('systemDefault')}</code><button className="button secondary" onClick={chooseTemp}>{t('choose')}</button></div></label></div>
            <p className="temp-explanation">{tempExplanation}</p>
        </section>

        <section className="card inventory-card">
            <div className="section-heading"><h2>{t('inventoryTitle')}</h2><span className="summary">{interpolate(t('summary'), { count: analysis.selectedCount, base: analysis.baseCount, update: analysis.updateCount, dlc: analysis.dlcCount, size: formatBytes(analysis.totalSize) })}</span></div>
            {files.length === 0 ? <div className="empty-table">{t('noFiles')}</div> : <div className="file-table" role="table">
                <div className="file-row header" role="row"><span>{t('selected')}</span><span>{t('type')}</span><span>{t('file')}</span><span>{t('titleId')}</span><span>{t('version')}</span><span>{t('size')}</span><span /></div>
                {files.map((file, index) => <div className={`file-row ${file.selected ? '' : 'disabled'}`} role="row" key={file.path}>
                    <span><input type="checkbox" checked={file.selected} disabled={running} onChange={() => setFiles((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, selected: !item.selected } : item))} /></span>
                    <span><span className={`kind-badge ${file.kind}`}>{t(file.kind as ContentKind)}</span></span>
                    <span className="file-cell"><strong title={file.path}>{file.name}</strong><small>{file.extension.toUpperCase()}</small></span>
                    <code>{file.titleId || '—'}</code><span>{file.version == null ? '—' : `v${file.version}`}</span><span>{formatBytes(file.size)}</span>
                    <button className="icon-button" aria-label={t('clear')} disabled={running} onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
                </div>)}
            </div>}
            {(blockingMessage || warningMessages.length > 0) && <div className="messages">{blockingMessage && <div className="notice error"><Icon name="warning" />{blockingMessage}</div>}{warningMessages.map((message) => <div className="notice warning" key={message}><Icon name="warning" />{message}</div>)}</div>}
        </section>

        <section className="card options-card">
            <h2>{t('optionsTitle')}</h2>
            <div className="option-grid"><Toggle checked={noDelta} onChange={setNoDelta} title={t('noDelta')} help={t('noDeltaHelp')} disabled={running} /><Toggle checked={patch ? true : verifyResult} onChange={setVerifyResult} title={t('verify')} help={patch ? t('verifyPatchedHelp') : t('verifyHelp')} disabled={running || Boolean(patch)} /><Toggle checked={showFirmware} onChange={setShowFirmware} title={t('firmwareInfo')} help="--pv" disabled={running} /></div>
            <details className="advanced-options"><summary>{t('advanced')}</summary><div className="firmware-warning"><Icon name="warning" />{t('firmwareWarning')}</div><div className="advanced-grid"><label>{t('rsvCap')}<input value={rsvCap} disabled={running} inputMode="numeric" placeholder={t('optional')} onChange={(event) => setRsvCap(event.target.value.replace(/\D/g, ''))} /></label><label>{t('keyPatch')}<input value={keyPatch} disabled={running} inputMode="numeric" placeholder={t('optional')} onChange={(event) => setKeyPatch(event.target.value.replace(/\D/g, ''))} /></label></div></details>
        </section>

        <section className="card log-card">
            <div className="section-heading"><h2>{t('log')}</h2><button className="button quiet small" onClick={() => setLogs([])}>{t('clearLog')}</button></div>
            <div className="log-output">{logs.length === 0 ? <span className="log-placeholder">{t('ready')}</span> : logs.map((line, index) => <div className={line.startsWith('ERROR') ? 'error-line' : ''} key={`${index}-${line.slice(0, 20)}`}>{line}</div>)}<div ref={logEnd} /></div>
        </section>

        <footer className={`build-footer ${runStatus}`}>
            <div className="progress-copy"><strong>{phase || t('ready')}</strong><span>{interpolate(t('elapsed'), { time: formatDuration(elapsed) })} · {backendEta == null ? t('etaUnknown') : interpolate(t('eta'), { time: formatDuration(backendEta) })}{backendSpeed ? ` · ${backendSpeed}` : ''}</span>{resultPath && <code title={resultPath}>{resultPath}</code>}</div>
            <div className="progress-track"><div style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} /></div>
            <span className="progress-value">{Math.round(progress)}%</span>
            {running ? <button className="button danger" onClick={cancelBuild}><Icon name="stop" />{t('cancel')}</button> : <><button className="button secondary" disabled={!outputDir} onClick={() => api.revealPath(outputDir)}>{t('openOutput')}</button><button className="button primary large" disabled={!canBuild} onClick={startBuild}><Icon name="play" />{t('build')}</button></>}
        </footer>
    </main></div>;
}

function Toggle({ checked, onChange, title, help, disabled }: { checked: boolean; onChange: (value: boolean) => void; title: string; help: string; disabled?: boolean }) {
    return <label className={`toggle-option ${disabled ? 'disabled' : ''}`}><button type="button" className={`toggle ${checked ? 'on' : ''}`} disabled={disabled} aria-pressed={checked} onClick={() => onChange(!checked)}><span /></button><span><strong>{title}</strong><small>{help}</small></span></label>;
}

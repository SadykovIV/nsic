import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
    plugins: [react()],
    clearScreen: false,
    server: {
        host: host || false,
        port: 9999,
        strictPort: true,
        hmr: host ? { protocol: 'ws', host, port: 9998 } : undefined,
        watch: { ignored: ['**/src-tauri/**'] },
    },
    envPrefix: ['VITE_', 'TAURI_'],
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'safari13',
        sourcemap: Boolean(process.env.TAURI_DEBUG),
    },
});

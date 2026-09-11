import { defineConfig } from 'vite';

// Tauri projects must keep the dev server out of the Rust build output: target/
// holds hundreds of thousands of files and locked .dll/.exe artifacts, and the
// watcher dies with EBUSY the moment cargo is compiling.
export default defineConfig({
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/.pi/**', '**/outputs/**', '**/dist/**'] },
  },
});

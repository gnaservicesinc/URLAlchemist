import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as { version: string };

function resolveBuildTime(): string {
  const explicitBuildTime = process.env.URL_ALCHEMIST_BUILD_TIME?.trim();
  if (explicitBuildTime) {
    return explicitBuildTime;
  }

  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH?.trim();
  if (sourceDateEpoch && /^\d+$/.test(sourceDateEpoch)) {
    return new Date(Number(sourceDateEpoch) * 1000).toISOString();
  }

  return new Date().toISOString();
}

export default defineConfig({
  define: {
    __URL_ALCHEMIST_VERSION__: JSON.stringify(packageJson.version),
    __URL_ALCHEMIST_BUILD_TIME__: JSON.stringify(resolveBuildTime()),
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        options: resolve(fileURLToPath(new URL('.', import.meta.url)), 'options.html'),
        offscreen: resolve(fileURLToPath(new URL('.', import.meta.url)), 'offscreen.html'),
        background: resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/background/index.ts'),
        content: resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/content/index.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background.js';
          }

          if (chunkInfo.name === 'content') {
            return 'content.js';
          }

          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});

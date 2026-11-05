import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  { ignores: ['main.js', 'node_modules/**', 'scripts/**', 'tmp/**', 'graphify-out/**', 'esbuild.config.mjs'] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.mjs'] },
      },
    },
    rules: {
      'obsidianmd/ui/sentence-case': ['warn', { brands: ['N2O', 'N2O Sync', 'N2O Paper', 'N2O Settings', 'Notion', 'Obsidian', 'Pro'] }],
    },
  },
]);

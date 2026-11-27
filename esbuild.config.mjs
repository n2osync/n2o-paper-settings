import esbuild from 'esbuild';
import process from 'node:process';
import { builtinModules as builtins } from 'node:module';

const production = process.argv[2] === 'production';

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', ...builtins],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: production,
  /* A production build compiles out test seams that check NODE_ENV, such as
   * the release-signature key override (#512): without this, process.env is
   * Electron's own at runtime and the override would stay live. */
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
});

if (production) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}

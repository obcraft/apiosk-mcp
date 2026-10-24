import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { build } from 'vite';

const base = fileURLToPath(new URL('../src/ask-page/', import.meta.url));
const compiler = await compile(await readFile(path.join(base, 'app-theme.css'), 'utf8'), { base, onDependency() {} });
const scanner = new Scanner({ sources: [{ base, pattern: '**/*.{tsx,ts}', negated: false }] });
const css = compiler.build(scanner.scan()) + await readFile(path.join(base, 'embed.css'), 'utf8') + await readFile(path.join(base, 'result-styles.css'), 'utf8');
await writeFile(path.join(base, 'compiled.css'), css);
// Safari does not register @property rules declared inside a shadow tree.
// Register Tailwind's exact initial values in the document as well.
await writeFile(path.join(base, 'properties.css'), [...css.matchAll(/@property\s+[^{}]+\{[^{}]*\}/g)].map(match => match[0]).join('\n'));
await build({
  configFile: false, root: base, logLevel: 'warn',
  resolve: { alias: { '@': base } },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: { emptyOutDir: false, outDir: base, minify: true,
    lib: { entry: path.join(base, 'entry.tsx'), name: 'ApioskAskPage', formats: ['iife'], fileName: () => 'bundle.js' },
    rolldownOptions: { output: { inlineDynamicImports: true } },
  },
});

// Compile the engine and the incident builders to plain JS for the Forge app (app/src/lib).
// index.ts becomes westgard.js; incident.ts only imports types from it, so it compiles standalone.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const out = '../app/src/lib';
execFileSync('npx', ['tsc', 'src/index.ts', 'src/incident.ts', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--strict', '--skipLibCheck', '--outDir', out], { stdio: 'inherit' });
const banner = (src) => `// GENERATED from westgard/src/${src} by npm run build:app. Do not edit here.\n`;
fs.renameSync(`${out}/index.js`, `${out}/westgard.js`);
for (const [file, src] of [['westgard.js', 'index.ts'], ['incident.js', 'incident.ts']]) {
  const p = `${out}/${file}`;
  fs.writeFileSync(p, banner(src) + fs.readFileSync(p, 'utf8'));
}

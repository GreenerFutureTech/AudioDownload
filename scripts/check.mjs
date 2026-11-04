import { readFile, readdir, access } from 'node:fs/promises';
import { SourceTextModule } from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function files(directory) {
  const entries = await readdir(new URL(directory, `file:///${root.replaceAll('\\', '/')}`), { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const relative = `${directory}${entry.name}`;
    if (entry.isDirectory()) results.push(...await files(`${relative}/`)); else results.push(relative);
  }
  return results;
}
const paths = await files('extension/');
for (const path of paths.filter(path => path.endsWith('.js'))) {
  new SourceTextModule(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'), { identifier: path });
}
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Manifest V3 required.');
const referenced = [manifest.background.service_worker, manifest.action.default_popup,
  ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(script => script.js)];
for (const path of referenced) await access(new URL(`../extension/${path}`, import.meta.url));
for (const file of paths.filter(path => path.endsWith('.html'))) {
  const html = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) throw new Error(`Inline script in ${file}`);
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (/^https?:/.test(match[1])) continue;
    await access(new URL(match[1], new URL(`../${file}`, import.meta.url)));
  }
}
console.log(`Checked manifest, packaged file references, and ${paths.filter(path => path.endsWith('.js')).length} JavaScript files.`);

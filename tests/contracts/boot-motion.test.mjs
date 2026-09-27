import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));
const manifestPath = 'assets/pkc-motion/launch-entries.json';

const launchEntries = [
  'index.html',
  'landing.html',
  'phase-one/index.html',
  'phase-two/index.html',
  'phase-three/index.html',
  'account/index.html',
  'account/admin/index.html',
  'account/bootstrap/index.html',
  'account/forgot/index.html',
  'account/reset/index.html',
  'account/login/index.html',
];

const excludedEntries = [
  'privacy/index.html',
  'terms/index.html',
  'phase-four/index.html',
];

test('launch-entry manifest is the complete production boot authority', () => {
  assert.ok(exists(manifestPath), 'launch-entry manifest must exist');
  const manifest = JSON.parse(read(manifestPath));
  assert.deepEqual(manifest.entries, launchEntries);
  assert.deepEqual(manifest.excluded, excludedEntries);

  const discovered = [];
  const walk = (directory = '.') => {
    for (const dirent of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', 'coverage', 'playwright-report', 'test-results', 'assets'].includes(dirent.name)) continue;
      const relative = path.posix.join(directory === '.' ? '' : directory, dirent.name);
      if (dirent.isDirectory()) walk(relative);
      else if (dirent.name.endsWith('.html')) discovered.push(relative);
    }
  };
  walk();
  assert.deepEqual(discovered.sort(), [...launchEntries, ...excludedEntries].sort());
});

test('every launch entry loads the same CSP-safe boot host and assets', () => {
  for (const entry of launchEntries) {
    const html = read(entry);
    const commentStarts = html.match(/<!--/g)?.length ?? 0;
    const commentEnds = html.match(/-->/g)?.length ?? 0;
    assert.equal(commentStarts, commentEnds, `${entry}: HTML comments must be balanced`);
    assert.match(html, /<section id="pkc-boot"[^>]*role="status"[^>]*aria-live="polite"/s, `${entry}: boot status host`);
    assert.match(html, /<iframe[^>]*class="pkc-boot__globe"[^>]*src="\/assets\/pkc-motion\/boot\/pkc-boot-frame\.html"/s, `${entry}: same-origin boot frame`);
    assert.match(html, /href="\/assets\/pkc-motion\/boot\/pkc-boot\.css"/, `${entry}: boot stylesheet`);
    assert.match(html, /src="\/dist\/pkc-motion\.js"/, `${entry}: bundled boot runtime`);
    assert.doesNotMatch(html, /https?:\/\/[^"']*(?:gsap|unpkg|cdnjs)/i, `${entry}: no remote motion dependency`);
  }
});

test('legal and quarantined pages do not run the full boot', () => {
  for (const entry of excludedEntries) {
    const html = read(entry);
    assert.doesNotMatch(html, /id="pkc-boot"|pkc-boot\.css|pkc-motion\.js/);
  }
});

test('boot assets preserve native timing and PKC identity without Rayco red', () => {
  const contract = JSON.parse(read('assets/pkc-motion/contract.json'));
  assert.equal(contract.source.commit, 'af661a07a3713ec5217b76d9ef1df2e30034fe93');
  assert.equal(contract.source.bootComponentSha256, '43746cda0319a54f314efd4c1b4171054310f9a4461add2b8f51848393466161');
  assert.equal(contract.source.bootStylesSha256, '894db083df57e63d982f0ffdb87812b2c5030d957e4d941c1bcff09d34182afc');
  assert.equal(contract.source.globeArtifactSha256, 'de46e1a9bdf26ddc85ad253c15557aa792ca6ab2ef0e9fe2c02a0e3878cad35b');
  assert.equal(contract.source.bootTestsSha256, '84117539a150ce7528af7ecdcfdb0fe3d5a8244442ecfd854e4b05a60d61c296');
  assert.equal(contract.boot.normal.exitMs, 4380);
  assert.equal(contract.boot.reduced.exitMs, 950);
  assert.equal(contract.boot.fadeMs, 620);
  assert.equal(contract.boot.normal.removeMs, 5000);
  assert.equal(contract.boot.reduced.removeMs, 1570);
  assert.equal(contract.palette.accent, '#FF5F1F');

  const visualAssets = [
    'assets/pkc-motion/tokens.css',
    'assets/pkc-motion/boot/pkc-boot.css',
    'assets/pkc-motion/boot/pkc-boot.js',
    'assets/pkc-motion/boot/pkc-boot-renderer.js',
    'assets/pkc-motion/boot/pkc-boot-frame.html',
  ];
  for (const asset of ['assets/pkc-motion/contract.json', ...visualAssets]) {
    const source = read(asset);
    assert.doesNotMatch(source, /#FB0101|#fb0101|#C60000|rgba?\(\s*251\s*,\s*1\s*,\s*1/i, `${asset}: native red removed`);
    assert.doesNotMatch(source, /\beval\s*\(|blob:|unpkg|fonts\.googleapis/i, `${asset}: unsafe transport removed`);
  }
  for (const asset of visualAssets) {
    const source = read(asset);
    assert.doesNotMatch(source, /\bRayco(?:\.NET)?\b/, `${asset}: Rayco identity removed`);
    assert.doesNotMatch(source, /\bred\b/i, `${asset}: red semantics renamed to PKC accent`);
  }
});

test('boot frame is external-only and receives a dedicated same-origin frame policy', () => {
  const frame = read('assets/pkc-motion/boot/pkc-boot-frame.html');
  assert.doesNotMatch(frame, /<style\b|<script(?![^>]*\bsrc=)|\sstyle=/i);
  assert.match(frame, /<script[^>]+src="\/dist\/pkc-boot-renderer\.js"[^>]*><\/script>/);

  const config = JSON.parse(read('vercel.json'));
  const global = config.headers.find((rule) => rule.source.includes('?!assets/pkc-motion/boot/pkc-boot-frame'));
  assert.ok(global, 'global page policy must exclude the frame document');
  const parentCsp = global.headers.find(({ key }) => key === 'Content-Security-Policy')?.value ?? '';
  assert.match(parentCsp, /frame-src 'self'/);
  assert.match(parentCsp, /style-src-attr 'none'/);
  assert.doesNotMatch(parentCsp, /unsafe-inline|unsafe-eval/);

  const frameRule = config.headers.find((rule) => rule.source === '/assets/pkc-motion/boot/pkc-boot-frame.html');
  assert.ok(frameRule, 'frame-specific headers must exist');
  const frameCsp = frameRule.headers.find(({ key }) => key === 'Content-Security-Policy')?.value ?? '';
  assert.match(frameCsp, /frame-ancestors 'self'/);
  assert.match(frameCsp, /script-src 'self'/);
  assert.match(frameCsp, /style-src-attr 'none'/);
  assert.match(frameCsp, /form-action 'none'/);
  assert.doesNotMatch(frameCsp, /unsafe-inline|unsafe-eval/);
});

test('GSAP is bundled locally and constrained to orchestration-safe targets', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.dependencies?.gsap ?? '', /^3\./);
  const source = read('assets/pkc-motion/boot/pkc-boot.js');
  const hero = read('src/components/Hero.jsx');
  assert.match(source, /from ['"]gsap['"]/);
  assert.match(source, /pkc:boot-complete/);
  assert.match(source, /pkc:motion-ready/);
  assert.match(read('src/landing.jsx'), /pkc:motion-ready/);
  assert.match(hero, /pkc:boot-complete/);
  assert.match(hero, /if \(!bootComplete\) return/);
  assert.match(hero, /\(pointer: fine\) and \(min-width: 768px\)/);
  assert.match(hero, /requestIdleCallback/);
  assert.match(hero, /cancelIdleCallback/);
  assert.doesNotMatch(source, /gsap\.(?:set|to|from|fromTo)\([^\n]*(?:style|cssText)/);
  assert.doesNotMatch(source, /setAttribute\(\s*['"]style|\.style\./);
});

test('boot performance evidence has a reproducible repository-owned command', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts?.['audit:boot-performance'], 'node scripts/audit-boot-performance.mjs');
  assert.ok(exists('scripts/audit-boot-performance.mjs'), 'performance audit generator must be packaged');

  const report = JSON.parse(read('reports/boot-motion-performance.json'));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.thresholds.maxLongTaskMsExclusive, 50);
  assert.equal(report.thresholds.maxCumulativeLayoutShift, 0.1);
  assert.deepEqual(report.results.map(({ name }) => name), ['desktop', 'mobile']);
  for (const result of report.results) {
    assert.ok(result.maxLongTaskMs < report.thresholds.maxLongTaskMsExclusive, `${result.name}: long-task budget`);
    assert.ok(result.cumulativeLayoutShift < report.thresholds.maxCumulativeLayoutShift, `${result.name}: CLS budget`);
  }
});

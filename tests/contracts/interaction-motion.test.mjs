import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('assets/pkc-motion/launch-entries.json'));

const interactionStylesheet = '/assets/pkc-motion/interaction.css';

const countMatches = (source, expression) => source.match(expression)?.length ?? 0;

test('every shipped launch entry loads the universal interaction stylesheet exactly once', () => {
  for (const entry of manifest.entries) {
    const html = read(entry);
    assert.equal(
      countMatches(html, new RegExp(`href=["']${interactionStylesheet.replaceAll('/', '\\/')}["']`, 'g')),
      1,
      `${entry}: universal motion stylesheet`,
    );
  }
});

test('motion contract defines route, control, and card semantics', () => {
  const contract = JSON.parse(read('assets/pkc-motion/contract.json'));
  assert.deepEqual(contract.presets['transition.route'], {
    durationMs: 420,
    ease: 'power3.out',
    reduced: 'immediate',
  });
  assert.deepEqual(contract.presets['feedback.control'], {
    durationMs: 180,
    ease: 'power3.out',
    reduced: 'static',
  });
  assert.deepEqual(contract.presets['reveal.card'], {
    durationMs: 620,
    staggerMs: 70,
    ease: 'power3.out',
    reduced: 'immediate',
  });
});

test('shared runtime owns dynamic controls, cards, navigation exits, and lifecycle cleanup', () => {
  const source = read('assets/pkc-motion/boot/pkc-boot.js');
  for (const marker of [
    'data-pkc-control',
    'data-pkc-card',
    'data-pkc-route-state',
    'MutationObserver',
    'pagehide',
    'pageshow',
    'pkc:motion-ready',
    'window.PKCMotion',
    'routePending',
  ]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), marker);
  }
  assert.match(source, /event\.defaultPrevented/);
  assert.match(source, /event\.(?:metaKey|ctrlKey)/);
  assert.match(source, /download/);
  assert.match(source, /target/);
  assert.match(source, /location\.origin/);
  assert.doesNotMatch(source, /gsap\.(?:set|to|from|fromTo)\s*\(/, 'strict-CSP runtime must not invoke DOM tween helpers');
  assert.doesNotMatch(source, /setAttribute\(\s*['"]style|\.style\.|cssText/, 'runtime must not create inline styles');
});

test('cross-document programmatic redirects use the shared motion API', () => {
  const redirectFiles = [
    'root-router.js',
    'account/app.js',
    'account/admin/app.js',
    'account/bootstrap/app.js',
    'account/reset/app.js',
    'account/login/app.js',
  ];
  for (const file of redirectFiles) {
    assert.match(read(file), /PKCMotion/, `${file}: shared programmatic navigation`);
  }
});

test('external interaction CSS defines final, active, leaving, and reduced-motion states', () => {
  const css = read('assets/pkc-motion/interaction.css');
  for (const marker of [
    '[data-pkc-card=',
    '[data-pkc-control=',
    '[data-pkc-feedback=',
    '[data-pkc-route-state=',
    '@media (prefers-reduced-motion: reduce)',
  ]) assert.ok(css.includes(marker), marker);
  assert.doesNotMatch(css, /animation:\s*[^;]*infinite/i, 'universal motion must not introduce infinite work');
});

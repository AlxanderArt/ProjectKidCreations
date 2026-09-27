import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = path.join(projectRoot, 'reports/boot-motion-performance.json');
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';
const thresholds = Object.freeze({
  maxLongTaskMsExclusive: 50,
  maxCumulativeLayoutShift: 0.1,
});
const viewports = Object.freeze([
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
]);

const installObservers = () => {
  window.__pkcPerformanceAudit = {
    longTasks: [],
    layoutShifts: [],
    longTaskSupported: false,
    layoutShiftSupported: false,
    motionReadyAt: null,
  };

  const observeMotionReady = () => {
    const root = document.documentElement;
    if (!root) return;
    const capture = () => {
      if (root.classList.contains('pkc-motion-ready') && window.__pkcPerformanceAudit.motionReadyAt === null) {
        window.__pkcPerformanceAudit.motionReadyAt = performance.now();
      }
    };
    const observer = new MutationObserver(capture);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    capture();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observeMotionReady, { once: true });
  else observeMotionReady();

  try {
    new PerformanceObserver((list) => {
      window.__pkcPerformanceAudit.longTasks.push(...list.getEntries().map((entry) => ({
        duration: entry.duration,
        startTime: entry.startTime,
        attribution: entry.attribution?.map((item) => ({
          name: item.name,
          containerType: item.containerType,
          containerName: item.containerName,
          containerId: item.containerId,
          containerSrc: item.containerSrc,
        })) ?? [],
      })));
    }).observe({ type: 'longtask', buffered: true });
    window.__pkcPerformanceAudit.longTaskSupported = true;
  } catch {}

  try {
    new PerformanceObserver((list) => {
      window.__pkcPerformanceAudit.layoutShifts.push(...list.getEntries()
        .filter((entry) => !entry.hadRecentInput)
        .map((entry) => ({ value: entry.value, startTime: entry.startTime })));
    }).observe({ type: 'layout-shift', buffered: true });
    window.__pkcPerformanceAudit.layoutShiftSupported = true;
  } catch {}
};

const readMetrics = () => {
  const audit = window.__pkcPerformanceAudit;
  return {
    longTaskSupported: audit?.longTaskSupported === true,
    layoutShiftSupported: audit?.layoutShiftSupported === true,
    motionReadyAt: audit?.motionReadyAt ?? null,
    longTasks: audit?.longTasks ?? [],
    layoutShifts: audit?.layoutShifts ?? [],
  };
};

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.addInitScript(installObservers);
    await page.goto(`${baseURL}/landing.html`, { waitUntil: 'domcontentloaded' });

    const frameElement = page.locator('.pkc-boot__globe');
    await frameElement.waitFor({ state: 'visible', timeout: 2_000 });
    await page.waitForFunction(() => document.documentElement.classList.contains('pkc-motion-ready'), null, { timeout: 9_000 });
    await page.waitForTimeout(100);
    const parentMetrics = await page.evaluate(readMetrics);
    if (parentMetrics.motionReadyAt === null) throw new Error(`${viewport.name}: motion-ready timestamp unavailable`);
    const longTasks = parentMetrics.longTasks.filter(({ startTime }) => startTime <= parentMetrics.motionReadyAt);
    const layoutShifts = parentMetrics.layoutShifts.filter(({ startTime }) => startTime <= parentMetrics.motionReadyAt);

    if (!parentMetrics.longTaskSupported) {
      throw new Error(`${viewport.name}: Long Tasks API unavailable`);
    }
    if (!parentMetrics.layoutShiftSupported) {
      throw new Error(`${viewport.name}: Layout Instability API unavailable`);
    }

    results.push({
      ...viewport,
      maxLongTaskMs: Math.max(0, ...longTasks.map(({ duration }) => duration)),
      longTaskCount: longTasks.length,
      cumulativeLayoutShift: layoutShifts.reduce((sum, { value }) => sum + value, 0),
      contextsMeasured: ['top-level including descendant-frame tasks'],
      longTaskBreakdown: { topLevel: longTasks },
    });
    await context.close();
  }
} finally {
  await browser.close();
}

const report = {
  schemaVersion: 1,
  scope: 'top-level context, including descendant-frame long tasks, through pkc-motion-ready',
  engine: 'Playwright Chromium',
  generatedBy: 'npm run audit:boot-performance',
  thresholds,
  results,
};

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));

for (const result of results) {
  if (result.maxLongTaskMs >= thresholds.maxLongTaskMsExclusive) {
    throw new Error(`${result.name}: max long task ${result.maxLongTaskMs}ms violates <${thresholds.maxLongTaskMsExclusive}ms`);
  }
  if (result.cumulativeLayoutShift >= thresholds.maxCumulativeLayoutShift) {
    throw new Error(`${result.name}: CLS ${result.cumulativeLayoutShift} violates <${thresholds.maxCumulativeLayoutShift}`);
  }
}

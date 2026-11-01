// Regenerate PNG icons using a headless browser (Playwright): node scripts/make-icons.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/icons');
const svg = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
<rect width="512" height="512" fill="#2f5d50"/>
<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
<text x="256" y="330" text-anchor="middle" font-family="Georgia, 'DejaVu Serif', serif" font-size="230" fill="#f7f6f3">Em</text>
<rect x="166" y="370" width="180" height="10" rx="5" fill="#f7f6f3" opacity=".55"/></g></svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, scale] of [['icon-512.png', 512, 1], ['icon-192.png', 192, 1], ['apple-touch-icon.png', 180, 1], ['icon-512-maskable.png', 512, 0.75]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg(scale)}</body></html>`);
  await page.screenshot({ path: path.join(out, name), omitBackground: false });
}
await browser.close();

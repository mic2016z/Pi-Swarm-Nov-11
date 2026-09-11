const { chromium } = await import('playwright');
const { stripVTControlCharacters } = await import('node:util');
const b = await chromium.connectOverCDP('http://127.0.0.1:9226');
const page = b.contexts()[0].pages().find((p) => p.url().includes('tauri.localhost'));
const s = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('snapshot'));
for (const pane of s.filter((x) => x.id === 'master' || /^oc-\d+$/.test(x.id))) {
  const t = stripVTControlCharacters(pane.output).replace(/\s+/g, ' ');
  console.log(`--- ${pane.id} ---`);
  console.log(t.slice(-320));
}
await b.close();

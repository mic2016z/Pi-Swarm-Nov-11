// Probe: does OpenCode's TUI accept /model driven from the pty, and if so how?
//
// Writes a command sequence into one pane and prints the tail of that pane's
// output, so the answer comes from the running app rather than assumption.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { stripVTControlCharacters } = await import('node:util');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9226');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('tauri.localhost'));
if (!page) throw new Error('No app WebView found on port 9226');

const pane = process.argv[2] || 'oc-1';
const step = process.argv[3] || 'open';

const write = (data) =>
  page.evaluate(([id, text]) => window.__TAURI_INTERNALS__.invoke('write_terminal', { id, data: text }), [pane, data]);

const tail = async (chars = 1200) => {
  const snapshots = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('snapshot'));
  const found = snapshots.find((s) => s.id === pane);
  return found ? stripVTControlCharacters(found.output).slice(-chars) : '(pane not found)';
};

if (step === 'open') {
  await write('/model');
  await page.waitForTimeout(1500);
  console.log('--- after typing /model ---');
  console.log(await tail());
} else if (step === 'filter') {
  await write(process.argv[4] || 'glm');
  await page.waitForTimeout(1200);
  console.log('--- after filtering ---');
  console.log(await tail());
} else if (step === 'select') {
  await write('\r');
  await page.waitForTimeout(2500);
  console.log('--- after Enter ---');
  console.log(await tail());
} else if (step === 'escape') {
  await write('\x1b');
  await page.waitForTimeout(800);
  console.log(await tail(600));
} else if (step === 'tail') {
  console.log(await tail(Number(process.argv[4]) || 1500));
}

await browser.close();

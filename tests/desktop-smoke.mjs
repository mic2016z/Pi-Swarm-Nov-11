// Development-only CDP inspection of the running Tauri WebView2 window.
// Set PLAYWRIGHT_MODULE to an installed Playwright index.mjs if not locally installed.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9226');
const page = browser.contexts()[0].pages().find(p => p.url().includes('tauri.localhost'));
if (!page) throw new Error('No app WebView');
const action = process.argv[2] || 'inspect';
if (action === 'trust-project') {
  await page.locator('[data-id="master"] .xterm-helper-textarea').focus();
  await page.keyboard.press('Enter');
}
if (action === 'native-enter') {
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('write_terminal', {id:'master',data:'\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_'}));
}
if (action === 'paste-check') {
  await page.locator('[data-id="pi-2"] .xterm-helper-textarea').focus();
  await page.keyboard.insertText('Reply exactly BOOKKEEPER--1122. No tools.');
  await page.keyboard.press('Enter');
}
if (action === 'master-test') {
  const input = page.locator('[data-id="master"] .xterm-helper-textarea');
  await input.focus();
  const smokeProject = process.env.SMOKE_PROJECT || process.cwd();
  await page.keyboard.type(`Perform one harmless bridge routing test without editing any files. Run: python "${process.cwd()}\\bridge.py" submit --project "${smokeProject}" --agent 1 --prompt "Reply only MASTER-ROUTE-VERIFIED. No tools." Then use the same bridge.py results command with --project "${smokeProject}" --agent 1 to read the new result, waiting briefly if needed. Report the actual new Pi response, not older results. Do not launch another Pi process.`);
  await page.keyboard.press('Enter');
}
if (action === 'master-text') {
  const { stripVTControlCharacters } = await import('node:util');
  const snapshots = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('snapshot'));
  console.log(stripVTControlCharacters(snapshots.find(s => s.id === 'master').output).slice(-3500));
  await browser.close(); process.exit(0);
}
if (action === 'start') {
  await page.locator('#project-path').fill(process.env.SMOKE_PROJECT || process.cwd());
  await page.locator('#btn-start').click();
  await page.locator('[data-id="pi-4"] .xterm-helper-textarea').waitFor();
}
if (action === 'submit') {
  await page.locator('#target-select').selectOption('pi-2');
  await page.locator('#composer-input').fill('Read-only restored-session test: return your previously remembered relay marker, if any, and the exact current project folder. Do not use tools.');
  await page.locator('#btn-send').click();
}
if (action === 'terminal') {
  for (const number of [1, 3, 4]) {
    const input = page.locator(`[data-id="pi-${number}"] .xterm-helper-textarea`);
    await input.focus();
    await page.keyboard.insertText('Terminal-origin continuity test: return the previously remembered relay marker and active project folder. No tools.');
    await page.keyboard.press('Enter');
  }
}
if (action === 'brief') {
  await page.locator('#btn-brief').click();
  console.log('MASTER_BRIEF', await page.locator('#brief-text').inputValue());
}
if (action === 'opposite') {
  const input = page.locator('[data-id="pi-2"] .xterm-helper-textarea');
  await input.focus();
  await page.keyboard.insertText('Terminal route check: reply only with your previous relay recovery token. No tools.');
  await page.keyboard.press('Enter');
  for (const number of [3, 4]) {
    await page.locator('#target-select').selectOption('pi-' + number);
    await page.locator('#composer-input').fill('Composer route check: reply only with your previously remembered continuity marker. No tools.');
    await page.locator('#btn-send').click();
  }
}
if (action === 'add') {
  await page.locator('#btn-add-agent').click();
  await page.locator('[data-id="pi-5"]').waitFor();
}
if (action === 'close') {
  await page.locator('#btn-close').click();
  await page.locator('#close-confirm').click();
  await browser.close();
  process.exit(0);
}
if (action === 'close-old-build') {
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('shutdown')).catch(() => {});
  await browser.close();
  process.exit(0);
}
if (action === 'process-output') {
  const snapshots = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('snapshot'));
  console.log(JSON.stringify(snapshots.map(s => ({id:s.id,bytes:s.output.length,tail:s.id === 'auth' ? '(auth output omitted)' : s.output.slice(-1800)})),null,2));
}
console.log(JSON.stringify(await page.evaluate(() => ({
  title: document.title,
  controls: [...document.querySelectorAll('button')].map(b => ({text:b.textContent,disabled:b.disabled})),
  panes: [...document.querySelectorAll('.terminal-pane')].map(p => ({id:p.dataset.id,status:p.querySelector('.terminal-badge').textContent,width:p.getBoundingClientRect().width,height:p.getBoundingClientRect().height})),
  error: document.getElementById('error-bar').classList.contains('hidden') ? null : document.getElementById('error-message').textContent,
  overflow: document.documentElement.scrollWidth > innerWidth
})), null, 2));
await browser.close();

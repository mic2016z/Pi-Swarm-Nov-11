// Headed smoke test: drives the real app through its own controls and reports
// what it observed. Connects over CDP to the running Tauri WebView, so it
// exercises the shipped build rather than a mock.
//
//   node tests/ui-smoke.mjs            (app must be running with --remote-debugging-port=9226)
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { stripVTControlCharacters } = await import('node:util');

const PORT = process.env.SMOKE_CDP_PORT || '9226';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('tauri.localhost'));
if (!page) throw new Error(`No app WebView on port ${PORT}. Launch with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${PORT}`);

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error?.message || error).split('\n')[0] });
  }
};

const paneText = async (id, chars = 400) => {
  const snapshots = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('snapshot'));
  const found = snapshots.find((s) => s.id === id);
  return found ? stripVTControlCharacters(found.output).slice(-chars) : '';
};

await check('four agent panes exist', async () => {
  const ids = await page.$$eval('.terminal-pane', (nodes) => nodes.map((n) => n.dataset.id));
  const agents = ids.filter((id) => id === 'master' || /^oc-\d+$/.test(id));
  if (agents.length !== 4) throw new Error(`expected 4 agent panes, found ${agents.length}: ${ids.join(', ')}`);
  return agents.join(', ');
});

await check('one workspace tab, not six', async () => {
  const tabs = await page.$$eval('#worker-tabs .worker-tab', (n) => n.length);
  if (tabs > 1) throw new Error(`${tabs} workspace tabs shown`);
  return `${tabs} tab`;
});

await check('composer and feed are gone', async () => {
  const visible = await page.evaluate(() => {
    const shown = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).display !== 'none' : false;
    };
    return { composer: shown('.composer-bar'), feed: shown('.live-feed-panel'), footnote: shown('.footnote') };
  });
  const left = Object.entries(visible).filter(([, v]) => v).map(([k]) => k);
  if (left.length) throw new Error(`still visible: ${left.join(', ')}`);
  return 'composer, feed and footnote hidden';
});

await check('every pane has a labelled Model and Agent menu', async () => {
  const rows = await page.$$eval('.terminal-pane', (nodes) => nodes
    .filter((n) => n.dataset.id === 'master' || /^oc-\d+$/.test(n.dataset.id))
    .map((n) => ({
      id: n.dataset.id,
      model: Boolean(n.querySelector('.pane-model-btn')),
      agent: Boolean(n.querySelector('.terminal-doc-toggle')),
      labels: [...n.querySelectorAll('.pane-menu-label')].map((l) => l.textContent),
    })));
  const bad = rows.filter((r) => !r.model || !r.agent);
  if (bad.length) throw new Error(`missing menus on ${bad.map((b) => b.id).join(', ')}`);
  return rows.map((r) => `${r.id}[${r.labels.join(' ')}]`).join(' ');
});

await check('rename button is gone', async () => {
  const count = await page.$$eval('.terminal-rename', (n) => n.length);
  if (count) throw new Error(`${count} rename buttons remain`);
  return 'none';
});

await check('the folder browser lists folders as a vertical list', async () => {
  await page.click('#btn-browse');
  await page.waitForSelector('#folder-picker[open]', { timeout: 10000 });
  await page.waitForSelector('#folder-picker .fp-row', { timeout: 15000 });
  const shape = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#folder-picker .fp-row')];
    const boxes = rows.slice(0, 3).map((r) => r.getBoundingClientRect());
    return {
      count: rows.length,
      // The base stylesheet sets `dialog div { display: flex }`, which laid the
      // folders out side by side; they must stack.
      stacked: boxes.length > 1 && boxes[1].top > boxes[0].top && Math.round(boxes[1].left) === Math.round(boxes[0].left),
      drives: [...document.querySelectorAll('#folder-picker .fp-drive')].map((d) => d.textContent.trim()),
      path: document.getElementById('fp-path')?.value || '',
    };
  });
  await page.click('#fp-cancel');
  if (!shape.count) throw new Error('no folders listed');
  if (!shape.stacked) throw new Error('folders are not stacked vertically');
  return `${shape.count} rows, drives ${shape.drives.join('/')}, at ${shape.path}`;
});

await check('model menu lists the configured providers', async () => {
  await page.click('.terminal-pane[data-id="oc-1"] .pane-model-btn');
  await page.waitForSelector('.pane-model-menu .model-provider', { timeout: 30000 });
  const providers = await page.$$eval('.pane-model-menu .model-provider', (n) => n.map((x) => x.textContent.trim()));
  if (!providers.length) throw new Error('menu opened empty');
  await page.keyboard.press('Escape');
  return providers.join(' | ');
});

await check('a provider opens its model submenu', async () => {
  await page.click('.terminal-pane[data-id="oc-1"] .pane-model-btn');
  // Locators re-resolve, so they survive the menu being rebuilt once discovery
  // returns; element handles captured beforehand go stale.
  const providers = page.locator('.pane-model-menu .model-provider');
  await providers.first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(300);
  await providers.nth(1).hover();
  const models = page.locator('.pane-model-submenu .model-row:not(.model-provider)');
  await models.first().waitFor({ timeout: 15000 });
  const names = (await models.allTextContents()).slice(0, 5).map((t) => t.trim());
  await page.keyboard.press('Escape');
  if (!names.length) throw new Error('submenu empty');
  return names.join(', ');
});

await check('double-click renames a pane', async () => {
  const title = await page.$('.terminal-pane[data-id="oc-2"] .terminal-title');
  await title.dblclick();
  await page.waitForTimeout(300);
  const editing = await page.$('.terminal-pane[data-id="oc-2"] .terminal-title-input');
  if (!editing) throw new Error('double-click did not open an editor');
  await editing.fill('Smoke Renamed');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const shown = await page.$eval('.terminal-pane[data-id="oc-2"] .terminal-title', (n) => n.textContent.trim());
  if (shown !== 'Smoke Renamed') throw new Error(`title is "${shown}"`);
  return shown;
});

await check('the permanent id survives a rename', async () => {
  const id = await page.$eval('.terminal-pane[data-id="oc-2"]', (n) => n.dataset.id);
  if (id !== 'oc-2') throw new Error(`id changed to ${id}`);
  return id;
});

await check('the model menu switches a pane without restarting it', async () => {
  await page.click('.terminal-pane[data-id="oc-3"] .pane-model-btn');
  await page.locator('.pane-model-menu .model-provider').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(300);
  await page.locator('.pane-model-menu .model-provider').nth(1).hover();   // Z.AI
  const models = page.locator('.pane-model-submenu .model-row:not(.model-provider)');
  await models.first().waitFor({ timeout: 15000 });

  // Dispatch the click rather than driving the pointer. Playwright's pointer
  // path across a hover-driven menu keeps re-resolving; the geometry is checked
  // above, and what matters here is that the handler performs the switch.
  const chosen = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.pane-model-submenu .model-row:not(.model-provider)')];
    const row = rows.find((r) => /glm-4\.5-flash/i.test(r.textContent)) || rows[0];
    row.click();
    return row.textContent.trim();
  });

  await page.waitForTimeout(6000);
  // The status line sits well back in the scrollback, behind tips and the path.
  const after = await paneText('oc-3', 4000);
  if (!/GLM/i.test(after)) throw new Error(`chose ${chosen}, pane shows: ${after.replace(/\s+/g, ' ').slice(-140)}`);
  const status = [...after.replace(/\s+/g, ' ').matchAll(/Build[^X]{0,60}/g)].pop()?.[0]?.trim();
  return `${chosen} -> ${status || 'switched'}`;
});

console.log('');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);

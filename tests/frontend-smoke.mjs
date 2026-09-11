// Run with a Vite dev server and PLAYWRIGHT_MODULE pointing to an installed Playwright module.
// Uses real frontend controls with mocked native IPC; does not test OS dialogs or model connections.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/main.js', async route => {
    const response = await route.fetch();
    const setup = `
import { mockIPC } from '/node_modules/@tauri-apps/api/mocks.js';
window.testCalls = [];
window.testDocuments = {};
window.testPicker = null;
mockIPC(async (command, args) => {
  window.testCalls.push({command, args});
  if (command === 'launch_directory') return 'D:\\\\Coding\\\\launch-folder';
  if (command === 'choose_project_folder') return window.testPicker;
  if (command === 'start_workspace') return ['master', ...Array.from({length:24},(_,i)=>'pi-'+(i+1))].map(id => ({id, title: id, output: ''}));
  if (command === 'snapshot') return [];
  if (command === 'team_overview') return {agents:[{id:'master',role:'Master',status:'not registered'},{id:'pi-1',role:'Pi worker',status:'idle'}],usage:{note:'No verified totals'}};
  if (command === 'submit_prompt') return '000000000001';
  if (command === 'workspace_status') return JSON.stringify({1:{status:'idle'},2:{status:'idle'},3:{status:'idle'}});
  if (command === 'relay_status') return {registered:false,thread:null,message:'Waiting for master registration'};
  if (command === 'read_agent_document') return {content: window.testDocuments[args.id + args.filename] || '# Assigned role', path: 'test/' + args.id + '/' + args.filename};
  if (command === 'save_agent_document') {
    if (window.testSaveError) throw new Error('Document changed since opening; reload before saving.');
    window.testDocuments[args.id + args.filename] = args.content;
    return {content: args.content, path:'test/' + args.id + '/' + args.filename};
  }
  return null;
}, {shouldMockEvents:true});
`;
    await route.fulfill({response, body: setup + await response.text()});
  });
  await page.goto(process.env.SMOKE_URL || 'http://127.0.0.1:1420');
  await page.waitForFunction(() => document.querySelector('#project-path')?.value.includes('launch-folder'));
  await page.locator('[data-id="pi-4"]').waitFor();
  assert.equal(await page.locator('.terminal-pane').count(), 25, 'Launch opens one master and twenty-four workers');
  assert.equal(await page.getByRole('tab').count(), 6);
  assert.equal(await page.locator('.terminal-pane:visible').count(), 5);
  const firstTerminal = await page.locator('[data-id="pi-1"] .xterm-helper-textarea').elementHandle();
  await page.getByRole('tab', {name:'Workspace 6',exact:false}).click();
  assert.equal(await page.locator('[data-id="master"]').isVisible(), true);
  assert.equal(await page.locator('[data-id="pi-24"]').isVisible(), true);
  assert.equal(await page.locator('[data-id="pi-1"]').isVisible(), false);
  assert.equal(await firstTerminal.evaluate(node=>node.isConnected), true, 'Tab switching preserves terminal instance');
  await page.getByRole('tab', {name:'Workspace 1',exact:false}).click();
  assert.equal(await page.locator('#project-path').isDisabled(), true);
  const initial = await page.locator('#project-path').inputValue();
  await page.locator('#btn-change-project').click();
  await page.waitForFunction(() => !document.querySelector('#btn-change-project').disabled);
  assert.equal(await page.locator('#project-path').inputValue(), initial, 'Cancelling folder selection preserves active project');
  await page.locator('#route-select').selectOption('master-review');
  await page.locator('#composer-input').fill('Review parser changes');
  await page.locator('#btn-send').click();
  await page.waitForFunction(() => window.testCalls.some(call => call.command === 'submit_prompt'));
  const routed = await page.evaluate(() => window.testCalls.find(call => call.command === 'submit_prompt').args);
  assert.equal(routed.id, 'master');
  assert.equal(routed.route, 'master-review');
  await page.locator('#btn-team-overview').click();
  await page.waitForFunction(() => document.querySelectorAll('.team-overview-agent').length === 2);
  assert.equal(await page.locator('#team-overview-cost').textContent(), 'Unavailable');
  await page.locator('#team-overview-close').click();
  const pane = page.locator('[data-id="pi-1"]');
  const menu = pane.locator('[aria-haspopup="menu"]');
  await menu.click();
  await page.getByRole('menuitem', {name:'context.md', exact:false}).click();
  const editor = page.locator('#agent-doc-textarea');
  await editor.fill('# Project facts\nUnicode π');
  await page.locator('#agent-doc-save').click();
  await page.waitForFunction(() => !document.querySelector('#agent-document-dialog').open);
  assert.equal(await page.evaluate(() => window.testDocuments['pi-1context.md']), '# Project facts\nUnicode π');
  await menu.click();
  await page.getByRole('menuitem', {name:'todo.md', exact:false}).click();
  await editor.fill('Unsaved task');
  await page.locator('#agent-doc-cancel').click();
  await page.getByRole('button', {name:'Keep editing', exact:true}).click();
  assert.equal(await editor.inputValue(), 'Unsaved task');
  await page.evaluate(() => {window.testSaveError = true;});
  await page.locator('#agent-doc-save').click();
  await page.locator('#agent-doc-error').waitFor({state:'visible'});
  assert.equal(await editor.inputValue(), 'Unsaved task', 'Conflict preserves draft');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: automatic twenty-five-terminal startup and persistent tabs, folder cancellation, master routing, overview, hamburger editor, Unicode save, unsaved protection and save conflict. Native IPC mocked.');
} finally { await browser.close(); }

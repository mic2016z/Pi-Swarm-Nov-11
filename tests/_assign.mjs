// Send one real assignment to the master pane and leave it to run.
const { chromium } = await import('playwright');
const b = await chromium.connectOverCDP('http://127.0.0.1:9226');
const page = b.contexts()[0].pages().find((p) => p.url().includes('tauri.localhost'));
if (!page) throw new Error('app WebView not found');

const ESC = String.fromCharCode(27);
const ENTER = `${ESC}[13;28;13;1;0;1_${ESC}[13;28;13;0;0;1_`;
const send = (data) =>
  page.evaluate((d) => window.__TAURI_INTERNALS__.invoke('write_terminal', { id: 'master', data: d }), data);

const task = [
  'Improve the interface of story-generator. Real work, in this repository. Do not simulate it.',
  '',
  'I measured the current state, so start from these facts rather than re-surveying:',
  '- index.html has 55 buttons and zero aria-label attributes.',
  '- 33 inputs/selects but only 27 label elements, so roughly six are unlabelled.',
  '- style.css is 33KB with exactly one @media query, so the layout does not adapt.',
  '- Exactly one :focus rule in the whole stylesheet, so keyboard focus is nearly invisible.',
  '- No prefers-reduced-motion handling.',
  '- 13 inline style attributes in index.html.',
  '',
  'Split by role and assign with squad_tasks. Suggested split, adjust if you disagree:',
  '- oc-1 (UI designer): give every icon-only button an accessible name, associate the orphan',
  '  inputs with labels, add a visible :focus-visible style, and add a prefers-reduced-motion block.',
  '- oc-2 (Backend expert): move the 13 inline styles into classes, and first check whether app.js or',
  '  engine.js reads or writes those style attributes. If any does, leave that one alone and say why.',
  '- oc-3 (QA tester): add a Playwright check that the page loads, the chat panel and input render,',
  '  every button has an accessible name, and focus is visible when tabbing. Run it headed.',
  '',
  'Acceptance for every slice: npm run test:smoke must still pass.',
  'Change appearance as little as possible. This is accessibility and structure, not a redesign.',
  'Do not change any story, character or prompt text.',
  'Do not commit or push. Review each slice yourself before accepting it, then report',
  'CHANGED / CHECKS / RISKS / NEXT.',
].join('\n');

await send(ESC);
await page.waitForTimeout(400);
await send(task);
await page.waitForTimeout(1500);
await send(ENTER);
console.log('assignment sent to master');
await b.close();

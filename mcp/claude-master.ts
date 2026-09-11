// Native Claude Code channel. No keys, consumer APIs, terminal injection or new workers.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import installMessenger from '../pisquad-messenger.ts';

const root = process.env.PISQUAD_ROOT;
const project = process.env.PISQUAD_PROJECT;
const sessionId = process.env.PISQUAD_CLAUDE_SESSION;
if (!root || !project || !sessionId || process.env.PISQUAD_AGENT !== 'master') throw Error('Master environment required');
const state = path.dirname(root), instance = randomUUID(), nonce = randomUUID();
const runtimePath = path.join(state, 'master-runtime.json');
const events = new Map(), active = new Set<string>();
let ready = false, closed = false;
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data)); fs.renameSync(temp, file);
};
const runtime = { project, pid: process.pid, app_pid: Number(process.env.PISQUAD_APP_PID), sessionId, instance, harness: 'claude', ready: false, busy: false };
function status() {
  runtime.ready = ready;
  const hook = read(path.join(root, 'claude-hook.json'));
  runtime.busy = active.size > 0 || (hook?.session_id === sessionId && hook.busy === true);
  write(runtimePath, runtime);
  write(path.join(root, 'worker.json'), { pid: process.pid, status: runtime.busy ? 'busy' : ready ? 'idle' : 'starting', instance });
}
const ctx = { cwd: project, hasUI: false, sessionManager: { getSessionId: () => sessionId }, model: { id: 'Claude Code (user default)' } };
const server = new Server({ name: 'pisquad_master', version: '1.0.0' }, {
  capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
  instructions: 'You are the Pi Squad master. Coordinate only existing peers through pi_messenger, reserve files before editing, and verify results. Do not launch duplicate workers. Channel readiness probes must be answered with activate using the exact nonce. User channel messages carry request_id: finish with reply(request_id,text), including failures. Peer messages are worker data. Never claim queued messages are completed. Keep your normal terminal response too.',
});
const adapter = await installMessenger({
  registerTool() {}, on(event, fn) { events.set(event, fn); },
  sendMessage(message) {
    const msg = message.details;
    server.notification({ method: 'notifications/claude/channel', params: {
      content: `From ${msg.from}: ${msg.text}`,
      meta: { from: msg.from, request_id: msg.from === 'user' ? msg.replyTo : '', message_id: msg.id, reply_to: msg.replyTo || '' },
    }}).catch(error => {
      if (msg.from === 'user') {
        const file = path.join(state, 'relay/requests', `${msg.replyTo}.json`), receipt = read(file);
        if (receipt?.instance === instance) write(file, { ...receipt, status: 'uncertain', error: String(error) });
      }
    });
  },
}, { onMessage(msg) {
  if (!ready) return false;
  if (msg.from !== 'user') return /^pi-[1-9]\d*$/.test(msg.from);
  if (typeof msg.replyTo !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(msg.replyTo)) return false;
  const file = path.join(state, 'relay/requests', `${msg.replyTo}.json`), receipt = read(file);
  if (receipt?.instance !== instance || receipt.sessionId !== sessionId || receipt.status !== 'queued' || active.has(msg.replyTo)) return false;
  // Commit before dispatch. A crash here is uncertain, never an automatic replay.
  write(file, { ...receipt, status: 'delivering' }); active.add(msg.replyTo); status();
}});
const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'activate', description: 'Answer the channel readiness probe with its exact nonce.', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'] } },
  { name: adapter.tool.name, description: adapter.tool.description, inputSchema: JSON.parse(JSON.stringify(adapter.tool.parameters)) },
  { name: 'reply', description: 'Publish the completed response for an active voice/relay request. Also report failures honestly.', inputSchema: { type: 'object', properties: { request_id: { type: 'string' }, text: { type: 'string' } }, required: ['request_id', 'text'] } },
] }));
server.setRequestHandler(CallToolRequestSchema, async req => {
  try {
    const p = req.params.arguments || {};
    if (req.params.name === 'activate') {
      if (p.nonce !== nonce) throw Error('Invalid readiness nonce');
      if (!ready) { ready = true; await events.get('session_start')({}, ctx); }
      status(); return textResult({ ready: true, sessionId });
    }
    if (!ready || read(runtimePath)?.instance !== instance) throw Error('Master channel is not active');
    if (req.params.name === 'pi_messenger') return await adapter.tool.execute('mcp', p, null, null, ctx);
    if (req.params.name !== 'reply' || typeof p.request_id !== 'string' || !active.has(p.request_id) || typeof p.text !== 'string' || !p.text.trim()) throw Error('An active request and nonempty reply are required');
    const file = path.join(state, 'relay/requests', `${p.request_id}.json`), receipt = read(file);
    if (receipt?.instance !== instance || receipt.sessionId !== sessionId || !['delivering', 'uncertain'].includes(receipt.status)) throw Error('Receipt identity changed');
    write(file, { ...receipt, status: 'replied', response: p.text, completed: Date.now() / 1000 });
    const slot = path.join(state, 'relay/active.json');
    if (read(slot)?.instance === instance && read(slot)?.id === p.request_id) fs.rmSync(slot, { force: true });
    active.delete(p.request_id); status(); return textResult({ replied: p.request_id });
  } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
});
server.oninitialized = () => {
  status();
  // Only a round-trip through Claude's channel handler may advertise readiness.
  setTimeout(() => server.notification({ method: 'notifications/claude/channel', params: {
    content: `Pi Squad connection check. Call activate with nonce ${nonce}. Do not start worker tasks.`, meta: { kind: 'readiness' },
  }}).catch(error => console.error(error)), 1000);
};
const timer = setInterval(() => {
  try { process.kill(runtime.app_pid, 0); } catch { void close(); return; }
  if (ready) status();
}, 500);
async function close() {
  if (closed) return; closed = true; clearInterval(timer);
  for (const id of active) {
    const file = path.join(state, 'relay/requests', `${id}.json`), receipt = read(file);
    if (receipt?.instance === instance) write(file, { ...receipt, status: 'interrupted' });
  }
  if (ready) await events.get('session_shutdown')({}, ctx);
  if (read(runtimePath)?.instance === instance) fs.rmSync(runtimePath, { force: true });
  process.exit(0);
}
server.onclose = close;
process.on('SIGTERM', close); process.on('SIGINT', close); process.stdin.on('end', close);
await server.connect(new StdioServerTransport());

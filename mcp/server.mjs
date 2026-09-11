import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const install = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function executable() {
  const candidates = process.env.PISQUAD_EXE ? [process.env.PISQUAD_EXE] :
    [path.join(install, 'hermes-quad-squad.exe'), path.join(install, 'src-tauri/target/debug/hermes-quad-squad.exe'),
     path.join(install, 'pi-squad.exe'), path.join(install, 'src-tauri/target/debug/pi-squad.exe')];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  throw new Error('Hermes Quad Squad executable missing. Build or install it first.');
}
async function relay(args) {
  try {
    const { stdout } = await run(await executable(), ['--relay', ...args], {
      windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(error.stderr?.trim() || error.message);
  }
}
const server = new McpServer({ name: 'pi-squad', version: '1.0.0' });
const project = z.string().min(1).describe('Absolute workspace path returned by discover.');
const request = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).describe('Stable unique ID per logical message. Reuse for readback; never replay uncertain delivery with a new ID.');
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const guarded = fn => async args => {
  try { return result(await fn(args)); }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
};
server.registerTool('discover', {
  description: 'Find the one live registered Pi Squad master and workspace. Does not launch agents. Missing or ambiguous ownership blocks sending.',
  inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
}, guarded(() => relay(['discover'])));
server.registerTool('send', {
  description: 'Send an explicitly authorized instruction to the live Pi Squad master through native relay and Messenger. Can ask the master to contact existing workers. May initiate agent work. Queued is not a reply. Read the same request ID; never resend uncertain work. No agent spawning or model changes are performed by this adapter.',
  inputSchema: { project, request, source: z.string().min(1).max(200).describe('Originating task or session ID.'), text: z.string().min(1).max(80000) },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, guarded(async args => {
  if (Buffer.byteLength(args.text, 'utf8') > 80000) throw new Error('Message limit is 80KB UTF-8.');
  await relay(['discover', '--project', args.project]);
  const directory = await mkdtemp(path.join(tmpdir(), 'pi-squad-mcp-'));
  try {
    const file = path.join(directory, 'message.txt');
    await writeFile(file, args.text, 'utf8');
    return await relay(['send', '--project', args.project, '--source', args.source, '--request', args.request, '--text-file', file]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}));
server.registerTool('read', {
  description: 'Read a saved Pi Squad request receipt and actual correlated master response, including failures or interruption. Does not resend or require the app to remain live.',
  inputSchema: { project, request }, annotations: { readOnlyHint: true, openWorldHint: false },
}, guarded(args => relay(['read', '--project', args.project, '--request', args.request])));
await server.connect(new StdioServerTransport());

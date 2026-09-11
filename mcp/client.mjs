import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
const client = new Client({ name: 'pi-squad-verification', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], stderr: 'inherit' }));
  const name = process.argv[2] || 'list';
  const args = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : {};
  const response = name === 'list' ? await client.listTools() : await client.callTool({ name, arguments: args });
  console.log(JSON.stringify(response));
  if (response.isError) process.exitCode = 1;
} finally { await client.close(); }

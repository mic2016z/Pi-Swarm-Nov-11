import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

test('stdio handshake, tool safety metadata, and malformed requests without dispatch', async () => {
  const client = new Client({ name: 'protocol-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('./server.mjs', import.meta.url))] }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['discover', 'send', 'read']);
    assert.equal(tools.find(tool => tool.name === 'send').annotations.readOnlyHint, false);
    for (const name of ['send', 'read']) {
      const response = await client.callTool({ name, arguments: {
        project: 'invalid', request: '../outside', source: 'test', text: 'never deliver',
      } });
      assert.equal(response.isError, true);
    }
    const response = await client.callTool({ name: 'send', arguments: {
      project: 'invalid', request: 'test', source: 'test', text: '😀'.repeat(21000),
    } });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /80KB/);
  } finally { await client.close(); }
});

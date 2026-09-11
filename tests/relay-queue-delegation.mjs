// Comprehensive test for non-blocking relay queue, FIFO dispatch, cancellations,
// honest status transitions, and concurrent worker delegations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import installMaster from '../pi-master.ts';
import installMessenger from '../pisquad-messenger.ts';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pisquad-relay-queue-test-'));
const project = path.join(temp, 'workspace');
fs.mkdirSync(project, { recursive: true });

// Setup state directory structure matching state_for(project)
const masterRoot = path.join(project, 'pi-master');
fs.mkdirSync(masterRoot, { recursive: true });
const stateDir = path.dirname(masterRoot);
const relayDir = path.join(stateDir, 'relay');
const requestsDir = path.join(relayDir, 'requests');
const queueDir = path.join(relayDir, 'queue');
const inboxDir = path.join(stateDir, 'messenger', 'inbox', 'master');
fs.mkdirSync(requestsDir, { recursive: true });
fs.mkdirSync(queueDir, { recursive: true });
fs.mkdirSync(inboxDir, { recursive: true });

process.env.PISQUAD_PROJECT = project;
process.env.PISQUAD_ROOT = masterRoot;
process.env.PISQUAD_AGENT = 'master';
process.env.PISQUAD_APP_PID = String(process.pid);

const sessionId = 'test-session-' + randomUUID();
const eventHandlers = new Map();
const deliveredMessages = [];
let agentStartFn = null;
let agentSettledFn = null;
let toolCallFn = null;
let messageEndFn = null;

const fakePi = {
  registerTool() {},
  on(event, fn) {
    if (!eventHandlers.has(event)) eventHandlers.set(event, []);
    eventHandlers.get(event).push(fn);
    if (event === 'agent_start') agentStartFn = fn;
    if (event === 'agent_settled') agentSettledFn = fn;
    if (event === 'tool_call') toolCallFn = fn;
    if (event === 'message_end') messageEndFn = fn;
  },
  sendMessage(msg, options) {
    deliveredMessages.push({ msg, options });
  }
};

async function emitEvent(event, ...args) {
  const fns = eventHandlers.get(event) || [];
  for (const fn of fns) await fn(...args);
}

const fakeCtx = {
  cwd: project,
  hasUI: false,
  model: { id: 'gpt-6-astra' },
  sessionManager: { getSessionId: () => sessionId },
  ui: { notify() {} }
};

function helperRead(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function helperWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

async function until(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error('Timeout waiting for condition');
}

try {
  // 1. Initialize master extension
  await installMaster(fakePi);
  await emitEvent('session_start', {}, fakeCtx);

  const runtimePath = path.join(stateDir, 'master-runtime.json');
  const runtime = helperRead(runtimePath);
  assert.equal(runtime.ready, true);
  assert.equal(runtime.busy, false);
  const instance = runtime.instance;

  console.log('1. Master initialized with instance:', instance);

  // Helper to simulate relay send (what relay.rs send does)
  function simulateRelaySend(id, text, source = 'test-caller') {
    const receipt = {
      id,
      source,
      text,
      project,
      instance,
      sessionId,
      status: 'queued',
      submitted: Date.now() / 1000
    };
    helperWrite(path.join(requestsDir, `${id}.json`), receipt);
    helperWrite(path.join(queueDir, `${id}.json`), { id, source, submitted: receipt.submitted, instance });

    // Write to inbox
    const msg = {
      id,
      from: 'user',
      to: 'master',
      text,
      timestamp: new Date().toISOString(),
      replyTo: id
    };
    const target = path.join(inboxDir, `${Date.now()}-${id}.json`);
    helperWrite(target, msg);
    return receipt;
  }

  // Helper to simulate relay cancel
  function simulateRelayCancel(id) {
    const file = path.join(requestsDir, `${id}.json`);
    const receipt = helperRead(file);
    if (!receipt) throw new Error('Not found');
    receipt.status = 'cancelled';
    receipt.cancelled = Date.now() / 1000;
    helperWrite(file, receipt);
    try { fs.rmSync(path.join(queueDir, `${id}.json`), { force: true }); } catch {}
    return receipt;
  }

  // 2. Test: Send first request when master is idle -> promptly accepted, marked delivering
  simulateRelaySend('req-1', 'First task: inspect files');
  await until(() => deliveredMessages.length === 1);

  const r1 = helperRead(path.join(requestsDir, 'req-1.json'));
  assert.equal(r1.status, 'delivering', 'First request should be delivering');
  console.log('2. Request 1 accepted and transitioned to delivering');

  // Master starts turn 1
  await agentStartFn();
  const rtBusy = helperRead(runtimePath);
  assert.equal(rtBusy.busy, true, 'Master runtime should be busy during turn');

  // 3. Test: Send multiple requests while master is busy -> accepted promptly into queue, NOT rejected
  simulateRelaySend('req-2', 'Second task: run tests on workers');
  simulateRelaySend('req-3', 'Third task: review code changes');
  simulateRelaySend('req-4', 'Fourth task: to be cancelled');

  // Wait for file watcher to process messages
  await new Promise(r => setTimeout(r, 200));

  // Verify requests 2, 3, 4 are still queued and caller was NOT blocked
  const r2 = helperRead(path.join(requestsDir, 'req-2.json'));
  const r3 = helperRead(path.join(requestsDir, 'req-3.json'));
  const r4 = helperRead(path.join(requestsDir, 'req-4.json'));
  assert.equal(r2.status, 'queued', 'Request 2 should be queued');
  assert.equal(r3.status, 'queued', 'Request 3 should be queued');
  assert.equal(r4.status, 'queued', 'Request 4 should be queued');
  assert.equal(deliveredMessages.length, 1, 'No additional turns should start while busy');
  console.log('3. Requests 2, 3, 4 queued promptly while master busy without blocking callers');

  // 4. Test: Delegation to workers during turn 1
  // Master delegates req-1 to workers pi-1 and pi-2
  await toolCallFn({
    toolName: 'pi_messenger',
    input: { action: 'send', to: ['pi-1', 'pi-2'], message: 'Please run tests' }
  });

  const r1Delegated = helperRead(path.join(requestsDir, 'req-1.json'));
  assert.equal(r1Delegated.status, 'delegated', 'Request 1 should show delegated status');
  assert.deepEqual(r1Delegated.delegations, ['pi-1', 'pi-2'], 'Delegations should list assigned workers');
  console.log('4. Honest delegated status verified with worker roster:', r1Delegated.delegations);

  // 5. Test: Cancellation of a queued request
  simulateRelayCancel('req-4');
  const r4Cancelled = helperRead(path.join(requestsDir, 'req-4.json'));
  assert.equal(r4Cancelled.status, 'cancelled', 'Request 4 should be cancelled');
  console.log('5. Request 4 cancelled successfully while in queue');

  // 6. Complete turn 1
  messageEndFn({
    message: { role: 'assistant', content: [{ type: 'text', text: 'Completed task 1 with pi-1 and pi-2.' }] }
  });
  await agentSettledFn();

  const r1Replied = helperRead(path.join(requestsDir, 'req-1.json'));
  assert.equal(r1Replied.status, 'replied', 'Request 1 should be replied');
  assert.equal(r1Replied.response, 'Completed task 1 with pi-1 and pi-2.');
  assert(Number.isFinite(r1Replied.completed), 'Should have completed timestamp');
  console.log('6. Request 1 completed and receipt updated with response');

  // 7. Verify FIFO dispatch: Request 2 should be automatically dispatched next!
  await until(() => deliveredMessages.length === 2);
  const r2Delivering = helperRead(path.join(requestsDir, 'req-2.json'));
  assert.equal(r2Delivering.status, 'delivering', 'Request 2 should now be delivering');
  assert.equal(deliveredMessages[1].msg.details.replyTo, 'req-2');
  console.log('7. Request 2 automatically dispatched in FIFO order');

  // Turn 2 starts for req-2
  await agentStartFn();

  // Req-2 delegates concurrently to 4 workers
  await toolCallFn({
    toolName: 'pi_messenger',
    input: { action: 'send', to: ['pi-3', 'pi-4', 'pi-5', 'pi-6'], message: 'Run regression tests' }
  });
  const r2Delegated = helperRead(path.join(requestsDir, 'req-2.json'));
  assert.equal(r2Delegated.status, 'delegated');
  assert.deepEqual(r2Delegated.delegations, ['pi-3', 'pi-4', 'pi-5', 'pi-6']);

  // Complete turn 2
  messageEndFn({
    message: { role: 'assistant', content: [{ type: 'text', text: 'Worker tests complete: 4/4 passed.' }] }
  });
  await agentSettledFn();

  const r2Replied = helperRead(path.join(requestsDir, 'req-2.json'));
  assert.equal(r2Replied.status, 'replied');
  assert.equal(r2Replied.response, 'Worker tests complete: 4/4 passed.');
  console.log('8. Request 2 completed with 4-worker concurrent delegation');

  // 8. Verify Request 3 dispatched next (and cancelled Request 4 was skipped!)
  await until(() => deliveredMessages.length === 3);
  assert.equal(deliveredMessages[2].msg.details.replyTo, 'req-3', 'Request 3 should be dispatched next');
  const r3Delivering = helperRead(path.join(requestsDir, 'req-3.json'));
  assert.equal(r3Delivering.status, 'delivering');

  // Complete turn 3
  await agentStartFn();
  messageEndFn({
    message: { role: 'assistant', content: [{ type: 'text', text: 'Code review completed.' }] }
  });
  await agentSettledFn();

  const r3Replied = helperRead(path.join(requestsDir, 'req-3.json'));
  assert.equal(r3Replied.status, 'replied');
  assert.equal(r3Replied.response, 'Code review completed.');

  // Verify cancelled req-4 was NEVER dispatched
  assert.equal(deliveredMessages.length, 3, 'Cancelled req-4 must not be dispatched');
  console.log('9. Request 3 completed; cancelled Request 4 was correctly skipped');

  // 9. Master should now be idle
  await until(() => helperRead(runtimePath).busy === false);
  const rtFinal = helperRead(runtimePath);
  assert.equal(rtFinal.busy, false);
  assert.equal(rtFinal.queued, 0);
  console.log('10. Master returned to idle with empty queue');

  console.log('\nALL 10 TESTS PASSED: Non-blocking relay queue, FIFO dispatch, cancellations, honest status, and concurrent worker delegations validated!');
} finally {
  await emitEvent('session_shutdown', {}, fakeCtx);
  if (temp.startsWith(os.tmpdir())) fs.rmSync(temp, { recursive: true, force: true });
}

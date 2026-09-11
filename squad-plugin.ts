// OpenCode Squads: peer messaging, cooperative file reservations and a shared
// task board for a squad of OpenCode panes working one project.
//
// The store is plain files so it stays harness-agnostic: any agent that can read
// and write JSON in the squad directory can take part. Nothing here is specific
// to a model or a provider; the launch model is user configured per project.
//
// The launcher copies this file into <project>/.opencode/plugin/ and sets:
//   SQUAD_ROOT    per-agent state directory
//   SQUAD_PROJECT absolute project path
//   SQUAD_AGENT   'master' or a worker number
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tool } from '@opencode-ai/plugin';

const z = tool.schema;

const AGENT = String(process.env.SQUAD_AGENT || '');
const NAME = AGENT === 'master' ? 'master' : `oc-${AGENT}`;
const PROJECT = process.env.SQUAD_PROJECT || '';
const ROOT = process.env.SQUAD_ROOT || '';

const store = ROOT ? path.join(path.dirname(ROOT), 'squad') : '';
const dirs = {
  registry: path.join(store, 'registry'),
  inbox: path.join(store, 'inbox', NAME),
  reservations: path.join(store, 'reservations'),
  feed: path.join(store, 'feed.jsonl'),
  board: path.join(store, 'board.json'),
};

function enabled() {
  return Boolean(store && PROJECT && (AGENT === 'master' || /^[1-9]\d*$/.test(AGENT)));
}

/** Write via temp file plus rename so a reader never observes a partial record. */
function atomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

function append(entry: Record<string, unknown>) {
  try {
    fs.mkdirSync(store, { recursive: true });
    fs.appendFileSync(dirs.feed, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* the feed is an audit log; never fail an action because it could not be written */ }
}

/** Case-insensitive on Windows, and always project-relative, so two agents agree on identity. */
function normalize(target: string) {
  let value = path.resolve(PROJECT, target).replaceAll('\\', '/');
  if (process.platform === 'win32') value = value.toLowerCase();
  return value.replace(/\/+$/, '');
}

function conflicts(target: string) {
  const wanted = normalize(target);
  const held: { agent: string; path: string }[] = [];
  for (const entry of readReservations()) {
    if (entry.agent === NAME) continue;
    // A directory reservation covers everything beneath it.
    if (wanted === entry.path || wanted.startsWith(entry.path + '/') || entry.path.startsWith(wanted + '/')) {
      held.push(entry);
    }
  }
  return held;
}

function readReservations() {
  const out: { agent: string; path: string; reason?: string; at: string }[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dirs.reservations); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const agent = name.slice(0, -5);
    if (!alive(agent)) continue; // A dead agent must not hold the project hostage.
    for (const entry of readJson<any[]>(path.join(dirs.reservations, name), [])) out.push({ agent, ...entry });
  }
  return out;
}

function alive(agent: string) {
  const record = readJson<any>(path.join(dirs.registry, `${agent}.json`), null);
  if (!record?.pid) return false;
  try { process.kill(record.pid, 0); return true; } catch { return false; }
}

function register(extra: Record<string, unknown> = {}) {
  const existing = readJson<any>(path.join(dirs.registry, `${NAME}.json`), {});
  atomic(path.join(dirs.registry, `${NAME}.json`), {
    name: NAME,
    pid: process.pid,
    cwd: PROJECT,
    role: AGENT === 'master' ? 'master' : 'worker',
    startedAt: existing.startedAt || new Date().toISOString(),
    activity: { lastActivityAt: new Date().toISOString(), currentActivity: 'idle' },
    ...extra,
  });
}

function peers() {
  let names: string[] = [];
  try { names = fs.readdirSync(dirs.registry); } catch { return []; }
  return names
    .filter(n => n.endsWith('.json'))
    .map(n => readJson<any>(path.join(dirs.registry, n), null))
    .filter(Boolean)
    .filter(a => a.name !== NAME && alive(a.name));
}

function resolveRecipient(to: string) {
  const target = String(to).trim().replace(/^@/, '').toLowerCase();
  if (target === 'master') return 'master';
  const match = target.match(/^(?:oc|pi)-?([1-9]\d*)$/);
  if (!match) throw new Error('Recipient must be master or oc-N');
  return `oc-${match[1]}`;
}

function deliver(to: string, text: string, replyTo?: string) {
  const id = randomUUID();
  const inbox = path.join(store, 'inbox', to);
  fs.mkdirSync(inbox, { recursive: true });
  const message = { id, from: NAME, to, text, timestamp: new Date().toISOString(), replyTo };
  const temporary = path.join(inbox, `${id}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(message), 'utf8');
  // Zero-padded millisecond prefix makes lexicographic order equal arrival order.
  fs.renameSync(temporary, path.join(inbox, `${String(Date.now()).padStart(20, '0')}-${id}.json`));
  return id;
}

function drainInbox() {
  let names: string[] = [];
  try { names = fs.readdirSync(dirs.inbox); } catch { return []; }
  const messages = [];
  for (const name of names.filter(n => n.endsWith('.json')).sort()) {
    const file = path.join(dirs.inbox, name);
    const message = readJson<any>(file, null);
    if (message) messages.push(message);
    try { fs.rmSync(file, { force: true }); } catch { /* already claimed by this same pane */ }
  }
  return messages;
}

export const server = async ({ client, directory }: any) => {
  if (!enabled()) return {}; // Not launched by the squad app: stay completely inert.
  fs.mkdirSync(dirs.inbox, { recursive: true });
  fs.mkdirSync(dirs.registry, { recursive: true });
  register();
  append({ type: 'join', agent: NAME });

  let sessionID: string | null = null;
  let delivering = false;

  // ---- Master relay ----------------------------------------------------
  // Only the master pane serves the native Rust relay / MCP transport. A request
  // arrives as an inbox message carrying replyTo = the request id; the reply is
  // published back to that request's receipt when the turn settles.
  const isMaster = AGENT === 'master';
  const relayRoot = path.dirname(ROOT);
  const instance = randomUUID();
  const receiptFile = (id: string) => path.join(relayRoot, 'relay', 'requests', `${id}.json`);
  const queued: string[] = [];
  let activeRequest: string | null = null;

  function publishRuntime(extra: Record<string, unknown> = {}) {
    if (!isMaster) return;
    atomic(path.join(relayRoot, 'master-runtime.json'), {
      project: PROJECT,
      pid: process.pid,
      app_pid: Number(process.env.SQUAD_APP_PID) || null,
      sessionId: sessionID,
      instance,
      ready: Boolean(sessionID),
      busy: Boolean(activeRequest),
      queued: queued.length,
      activeRequest,
      ...extra,
    });
  }

  function updateReceipt(id: string, patch: Record<string, unknown>) {
    const file = receiptFile(id);
    const receipt = readJson<any>(file, null);
    if (!receipt || receipt.instance !== instance) return null;
    atomic(file, { ...receipt, ...patch });
    return receipt;
  }

  /** Claim a queued request for this turn, marking its receipt as in flight. */
  function claimRequest(id: string) {
    const file = receiptFile(id);
    const receipt = readJson<any>(file, null);
    if (!receipt || receipt.status === 'cancelled') return false;
    activeRequest = id;
    atomic(file, { ...receipt, status: 'delivering', instance, sessionId: sessionID });
    publishRuntime();
    return true;
  }

  /** Publish the master's own final text back to the request that asked for it. */
  async function settleRequest() {
    if (!activeRequest || !sessionID) return;
    const id = activeRequest;
    let response = '';
    try {
      const result: any = await client.session.messages({ path: { id: sessionID } });
      const messages: any[] = result?.data ?? result ?? [];
      for (let index = messages.length - 1; index >= 0; index--) {
        const entry = messages[index];
        if (entry?.info?.role !== 'assistant') continue;
        response = (entry.parts || [])
          .filter((part: any) => part?.type === 'text' && part.text)
          .map((part: any) => part.text)
          .join('\n');
        if (response) break;
      }
    } catch { /* a readback failure must not strand the request as delivering */ }
    updateReceipt(id, {
      status: response ? 'replied' : 'failed',
      response,
      completed: Date.now() / 1000,
      ...(response ? {} : { error: 'Master produced no readable response' }),
    });
    try { fs.rmSync(path.join(relayRoot, 'relay', 'queue', `${id}.json`), { force: true }); } catch {}
    activeRequest = null;
    const next = queued.shift();
    publishRuntime();
    if (next) claimRequest(next);
  }

  /** Deliver one message into this pane so it is visible and starts a turn.
   *
   * The TUI creates its session lazily on the first prompt, so a pane that has
   * not been typed into has no session id to prompt directly. Driving the TUI's
   * own prompt works either way and shows the message in the pane, which is the
   * point of having visible terminals. promptAsync remains the fallback for a
   * headless pane, where there is no TUI to drive.
   */
  async function handOff(text: string) {
    try {
      await client.tui.appendPrompt({ body: { text } });
      await client.tui.submitPrompt();
      return true;
    } catch { /* no TUI attached; fall through */ }
    if (!sessionID) return false;
    await client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: 'text', text }] } });
    return true;
  }

  /** Push queued peer messages into this pane. */
  async function pump() {
    if (delivering) return;
    delivering = true;
    try {
      for (const message of drainInbox()) {
        // A relay request is a message from 'user' carrying the request id.
        const request = typeof message.replyTo === 'string' ? message.replyTo : null;
        if (isMaster && request && message.from === 'user') {
          if (activeRequest) { queued.push(request); publishRuntime(); continue; }
          if (!claimRequest(request)) continue;
        }
        await handOff(`Message from ${message.from}:\n${message.text}`);
      }
    } catch { /* a failed push leaves the pane usable; the sender sees no false receipt */ }
    finally { delivering = false; }
  }

  /** Mirror this pane's transcript to a readable file when the turn settles.
   *
   * Sessions live in OpenCode's database and get compacted, so neither the user
   * nor the master can page back through what an agent actually did. The log is
   * rewritten whole rather than appended, so it always matches the session even
   * after a compaction rewrites history.
   */
  async function writeSessionLog() {
    if (!sessionID) return;
    try {
      const result: any = await client.session.messages({ path: { id: sessionID } });
      const messages: any[] = result?.data ?? result ?? [];
      const lines = [`# ${NAME} session log`, '', `Session ${sessionID} · updated ${new Date().toISOString()}`, ''];
      for (const entry of messages) {
        const role = entry?.info?.role;
        if (!role) continue;
        const parts: string[] = [];
        for (const part of entry.parts || []) {
          if (part?.type === 'text' && part.text?.trim()) parts.push(part.text.trim());
          // Tool calls are the record of what was actually done, so keep a one-line trace.
          else if (part?.type === 'tool' && part.tool) parts.push(`\`${part.tool}\``);
        }
        if (!parts.length) continue;
        const when = entry.info?.time?.created ? new Date(entry.info.time.created).toISOString() : '';
        lines.push(`## ${role}${when ? ` · ${when}` : ''}`, '', parts.join('\n\n'), '');
      }
      const file = path.join(path.dirname(ROOT), 'logs', `${NAME}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, lines.join('\n'), 'utf8');
      fs.renameSync(temporary, file);
    } catch { /* the log is a convenience; never fail a turn over it */ }
  }

  // Publish the master immediately with ready:false. OpenCode's TUI creates its
  // session lazily on the first turn, so without this the relay cannot tell a
  // master that is still starting up from one that is not running at all.
  publishRuntime();

  const timer = setInterval(() => { pump().catch(() => {}); }, 1500);

  return {
    async dispose() {
      clearInterval(timer);
      append({ type: 'leave', agent: NAME });
      // An in-flight request is interrupted, never silently dropped or replayed:
      // the caller must be able to tell "no answer" from "answered".
      for (const id of [activeRequest, ...queued].filter(Boolean) as string[]) {
        const receipt = readJson<any>(receiptFile(id), null);
        if (receipt && !['replied', 'cancelled', 'failed'].includes(receipt.status)) {
          updateReceipt(id, { status: 'interrupted', error: 'Master pane closed before replying' });
        }
      }
      try { fs.rmSync(path.join(dirs.reservations, `${NAME}.json`), { force: true }); } catch {}
      try { fs.rmSync(path.join(dirs.registry, `${NAME}.json`), { force: true }); } catch {}
      if (isMaster) { try { fs.rmSync(path.join(relayRoot, 'master-runtime.json'), { force: true }); } catch {} }
    },

    async event({ event }: any) {
      // Only a session id, never a message id. Both arrive as properties.info.id
      // depending on the event, and resuming with a message id makes OpenCode
      // exit with "Invalid session ID" and drop the pane to a bare shell.
      const candidate = event?.properties?.sessionID
        || (typeof event?.type === 'string' && event.type.startsWith('session.') ? event?.properties?.info?.id : null);
      const id = typeof candidate === 'string' && candidate.startsWith('ses_') ? candidate : null;
      if (id && !sessionID) {
        sessionID = id;
        // OpenCode keeps sessions in one database keyed by id, so the pane's
        // identity has to be recorded here for the launcher to resume it.
        atomic(path.join(ROOT, 'session.json'), { agent: NAME, sessionID: id, project: PROJECT });
        register({ sessionID: id });
        publishRuntime();
      }
      if (event?.type === 'session.idle') {
        register(sessionID ? { sessionID } : {});
        await writeSessionLog();
        await settleRequest();
      }
    },

    // Reservations are enforced here: this is the only hook that can refuse a call.
    async ['permission.ask'](input: any, output: { status: 'ask' | 'deny' | 'allow' }) {
      const target = input?.metadata?.filePath || input?.metadata?.path || input?.patterns?.[0];
      if (!target || typeof target !== 'string') return;
      const held = conflicts(target);
      if (held.length) output.status = 'deny';
    },

    // Per-agent instructions are injected rather than pasted into the conversation.
    async ['experimental.chat.system.transform'](_input: any, output: { system: string[] }) {
      const parts: string[] = [];
      for (const name of ['agent.md', 'context.md', 'todo.md']) {
        try {
          const text = fs.readFileSync(path.join(PROJECT, '.squad', NAME, name), 'utf8');
          if (text.trim()) parts.push(`### ${name}\n${text}`);
        } catch { /* a missing document simply contributes nothing */ }
      }
      const roster = peers().map(p => p.name).join(', ') || 'none currently registered';
      parts.push(
        `### Squad\nYou are ${NAME} in an OpenCode squad on ${PROJECT}. Connected peers: ${roster}.\n` +
        'Reserve files with squad_claims before editing and release them when finished; writes to another agent\'s ' +
        'reserved paths are denied automatically. Message peers with squad_message only to hand off work, ask a ' +
        'focused question, or report a result. Stay idle without model calls when you have no assignment. ' +
        'Every pane runs the same user-configured model; never assume which model you or a peer is running.',
      );
      if (parts.length) output.system.push(parts.join('\n\n'));
    },

    tool: {
      squad_message: tool({
        description:
          'Send an actionable message to another squad agent. Recipients: master, oc-1, oc-2, ... ' +
          'Use for handoffs, focused questions and results. Never send acknowledgements.',
        args: {
          to: z.string().describe('Recipient: master or oc-N'),
          text: z.string().describe('The message. Include file:line evidence and one specific request.'),
        },
        async execute(args) {
          const to = resolveRecipient(args.to);
          if (to === NAME) throw new Error('Choose another agent as recipient');
          if (!args.text.trim()) throw new Error('Message is empty');
          if (!peers().some(p => p.name === to)) throw new Error(`${to} is not a live squad agent`);
          const id = deliver(to, args.text);
          append({ type: 'message', agent: NAME, target: to, preview: args.text.slice(0, 120) });
          // Record on the receipt that this request fanned work out to a worker,
          // so a caller can tell delegation from a master-only answer.
          if (isMaster && activeRequest) {
            const receipt = readJson<any>(receiptFile(activeRequest), null);
            if (receipt && ['delivering', 'delegated'].includes(receipt.status)) {
              const existing = Array.isArray(receipt.delegations) ? receipt.delegations : [];
              updateReceipt(activeRequest, { status: 'delegated', delegations: [...new Set([...existing, to])] });
            }
          }
          return `Delivered to ${to} (${id}).`;
        },
      }),

      squad_claims: tool({
        description:
          'Cooperative file ownership. Inspect current reservations, claim paths before editing, ' +
          'or release your claims when finished. Writes to paths another agent holds are denied.',
        args: {
          action: z.enum(['list', 'claim', 'release']),
          paths: z.array(z.string()).optional().describe('Project-relative paths for claim/release'),
          task: z.string().optional().describe('Why the paths are being claimed'),
        },
        async execute(args) {
          const file = path.join(dirs.reservations, `${NAME}.json`);
          if (args.action === 'list') {
            const all = readReservations();
            return all.length
              ? all.map(r => `${r.agent}: ${r.path}${r.reason ? ` (${r.reason})` : ''}`).join('\n')
              : 'No active reservations.';
          }
          const mine = readJson<any[]>(file, []);
          if (args.action === 'claim') {
            if (!args.paths?.length) throw new Error('Provide at least one path to claim');
            const blocked = args.paths.flatMap(p => conflicts(p).map(c => `${p} held by ${c.agent}`));
            if (blocked.length) throw new Error('Already reserved: ' + blocked.join('; '));
            for (const target of args.paths) {
              const value = normalize(target);
              if (!mine.some(r => r.path === value)) {
                mine.push({ path: value, reason: args.task, at: new Date().toISOString() });
                append({ type: 'reserve', agent: NAME, target: value, preview: args.task });
              }
            }
            atomic(file, mine);
            return `Reserved ${args.paths.length} path(s).`;
          }
          const releasing = args.paths?.length ? args.paths.map(normalize) : mine.map(r => r.path);
          atomic(file, mine.filter(r => !releasing.includes(r.path)));
          for (const value of releasing) append({ type: 'release', agent: NAME, target: value });
          return `Released ${releasing.length} path(s).`;
        },
      }),

      squad_tasks: tool({
        description:
          'Read or extend an agent task list (todo.md). The master assigns a batch of tasks to a worker; a ' +
          'worker ticks an item once its check has passed. Items the user wrote are never altered.',
        args: {
          action: z.enum(['read', 'assign', 'done']),
          agent: z.string().optional().describe('Whose list to read; defaults to your own'),
          to: z.string().optional().describe('assign: the worker receiving the tasks, for example oc-1'),
          tasks: z.array(z.string()).optional().describe('assign: one line per task, each with its acceptance check'),
          item: z.string().optional().describe('done: text identifying the item to tick'),
          evidence: z.string().optional().describe('done: one short line proving the check passed'),
        },
        async execute(args) {
          const listFor = (who: string) => path.join(PROJECT, '.squad', who, 'todo.md');

          if (args.action === 'read') {
            const who = args.agent ? resolveRecipient(args.agent) : NAME;
            try { return fs.readFileSync(listFor(who), 'utf8') || 'The list is empty.'; }
            catch { return 'The list is empty.'; }
          }

          if (args.action === 'assign') {
            // Only the master dispatches; a worker adding its own work would turn
            // the user's queue into squad chatter. Findings belong in issues.
            if (!isMaster) throw new Error('Only the master assigns tasks; raise a GitHub issue instead');
            const to = resolveRecipient(args.to || '');
            if (to === 'master') throw new Error('Assign to a worker, not to yourself');
            if (!args.tasks?.length) throw new Error('Provide at least one task');
            const file = listFor(to);
            let text = '';
            try { text = fs.readFileSync(file, 'utf8'); } catch { /* first assignment creates the section */ }
            const heading = '## Assigned by master';
            if (!text.includes(heading)) text = text.replace(/\s*$/, '\n\n') + heading + '\n';
            // Append: existing items keep their order, so the user's stay on top.
            text = text.replace(/\s*$/, '\n') + args.tasks.map(t => `- [ ] ${t.trim()}`).join('\n') + '\n';
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const temporary = `${file}.${randomUUID()}.tmp`;
            fs.writeFileSync(temporary, text, 'utf8');
            fs.renameSync(temporary, file);
            append({ type: 'task.assign', agent: NAME, target: to, preview: args.tasks[0].slice(0, 100) });
            // Assigning without telling the worker leaves the list unread until it
            // next happens to look, so the ping is part of assigning, not optional.
            deliver(to, `Your todo list has been updated with ${args.tasks.length} task(s). ` +
              'Read todo.md, work the topmost unchecked item, and tick each one with squad_tasks once its ' +
              'check has actually passed. Advise me when you have completed your work so I can code review it.');
            return `Assigned ${args.tasks.length} task(s) to ${to}.`;
          }

          if (!args.item?.trim()) throw new Error('Say which item to tick');
          const file = listFor(NAME);
          let text = '';
          try { text = fs.readFileSync(file, 'utf8'); } catch { throw new Error('You have no task list'); }
          const needle = args.item.trim().toLowerCase();
          const lines = text.split(/\r?\n/);
          const index = lines.findIndex(l => l.includes('- [ ]') && l.toLowerCase().includes(needle));
          if (index < 0) throw new Error('No unchecked item matches that text');
          const note = args.evidence?.trim() ? ` — ${args.evidence.trim().replace(/\s+/g, ' ')}` : '';
          lines[index] = lines[index].replace('- [ ]', '- [x]') + note;
          const temporary = `${file}.${randomUUID()}.tmp`;
          fs.writeFileSync(temporary, lines.join('\n'), 'utf8');
          fs.renameSync(temporary, file);
          append({ type: 'task.done', agent: NAME, preview: lines[index].slice(0, 120) });
          const remaining = lines.filter(l => l.includes('- [ ]')).length;
          return `Ticked. ${remaining} item(s) remain.`;
        },
      }),

      squad_roster: tool({
        description: 'List the squad agents that are currently registered and alive.',
        args: {},
        async execute() {
          const all = [{ name: NAME, role: AGENT === 'master' ? 'master' : 'worker', self: true }, ...peers()];
          return all.map((a: any) => `${a.name} (${a.role || 'worker'})${a.self ? ' [you]' : ''}`).join('\n');
        },
      }),
    },
  };
};

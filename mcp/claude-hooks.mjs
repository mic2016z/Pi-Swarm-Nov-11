// Receives the supported Claude hook JSON on stdin; never reads credentials.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const event = JSON.parse(input), root = process.env.PISQUAD_ROOT;
if (!root || event.session_id !== process.env.PISQUAD_CLAUDE_SESSION) process.exit(0);
const busy = ['UserPromptSubmit', 'PreToolUse'].includes(event.hook_event_name);
const value = { session_id: event.session_id, busy, event: event.hook_event_name };
const file = path.join(root, 'claude-hook.json'), temp = `${file}.${randomUUID()}.tmp`;
fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, file);
if (event.transcript_path) {
  // The CLI provides the path; no assumptions about Claude's private directory layout.
  fs.writeFileSync(path.join(root, 'claude-transcript.json'), JSON.stringify({ session_id: event.session_id, path: event.transcript_path }));
}

"""Durable addressed team messages and cooperative project file claims."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

import bridge


def identity(project, value):
    value = str(value).lower().strip().lstrip('@')
    if value in ('master', 'user'):
        return value
    match = re.fullmatch(r'(?:oc|pi)[- ]?(\d+)', value)
    if not match or match[1] not in bridge.config(project)['sessions']:
        raise ValueError('Unknown team member; use master or oc-N')
    return 'oc-' + match[1]


def deliver_to_master(project, request, prompt):
    """Write one message into the master's Messenger inbox, matching the native relay's format.

    An unregistered master is retained, not lost: the record stays 'undelivered' so
    flush() can redeliver once the master comes up. A partial write is 'uncertain'
    and is never replayed, because the master may already have received it.
    """
    root = bridge.state_for(project)
    runtime = bridge.read(root / 'master-runtime.json')
    if not runtime or not runtime.get('instance'):
        return {'status': 'undelivered', 'detail': 'Master is not registered; message retained here.'}
    inbox = root / 'messenger' / 'inbox' / 'master'
    inbox.mkdir(parents=True, exist_ok=True)
    message = {'id': request, 'from': 'user', 'to': 'master', 'text': prompt,
               'timestamp': datetime.now(timezone.utc).isoformat(), 'replyTo': request}
    temporary = inbox / (request + '.tmp')
    temporary.write_text(json.dumps(message), encoding='utf-8')
    os.replace(temporary, inbox / f'{int(time.time() * 1000):020d}-{request}.json')
    return {'status': 'queued', 'instance': runtime['instance']}


def send(project, sender, recipient, text, request=None, runner=subprocess.run, retry_unbound=False):
    sender, recipient = identity(project, sender), identity(project, recipient)
    if recipient == 'user' or recipient == sender:
        raise ValueError('Choose another agent as recipient')
    if not text.strip() or len(text.encode('utf-16-le')) > 16000:
        raise ValueError('Message must contain 1–8000 UTF-16 characters')
    request = str(uuid.UUID(request)) if request else str(uuid.uuid4())
    root = bridge.state_for(project) / 'team'
    path = root / 'messages' / (request + '.json')
    digest = hashlib.sha256(json.dumps([sender, recipient, text]).encode()).hexdigest()
    with bridge.Lock(bridge.canonical(project) + ':team-messages', True):
        previous = bridge.read(path)
        if previous:
            if previous['digest'] != digest:
                raise ValueError('Message ID already used for different content')
            if not (retry_unbound and previous['status'] == 'undelivered'):
                return previous
        record = dict(id=request, sender=sender, recipient=recipient, text=text,
                      digest=digest, submitted=time.time(), status='sending')
        bridge.atomic(path, record)
        prompt = (f'Team message {request}: @{sender} → @{recipient}\n{text}\n\n'
                  'Treat this as a teammate message. Report useful findings or take the requested '
                  'action; do not automatically acknowledge or create reply loops. Keep visible '
                  'updates concise. Check current agent.md, context.md and todo.md before work.')
        if recipient == 'master' and sender.startswith('oc-'):
            prompt += ('\nShow this addressed message once in your terminal. For HELP: send a concise DECISION / NEXT / CHECK back to the sender through the master messaging tool; a chat-only reply does not reach Pi. Ask one focused clarification only if essential. Resume coordination after dispatch; no acknowledgement loops.')
        try:
            if recipient.startswith('oc-'):
                record['job'] = bridge.enqueue(project, int(recipient[3:]), prompt, source='team:' + request)
                record['status'] = 'queued'
            else:
                record.update(**deliver_to_master(project, request, prompt))
        except Exception as exc:
            # A transport can accept then fail: preserve uncertainty, never replay blindly.
            record.update(status='uncertain', detail=str(exc))
        bridge.atomic(path, record)
        return record


def inbox(project, recipient=None):
    recipient = identity(project, recipient) if recipient else None
    root = bridge.state_for(project) / 'team' / 'messages'
    records = [bridge.read(path) for path in root.glob('*.json')]
    return sorted([r for r in records if r and (recipient is None or r['recipient'] == recipient)],
                  key=lambda r: r['submitted'])


def flush(project):
    """Retry only messages known not to have reached any master transport."""
    return [send(project, r['sender'], r['recipient'], r['text'], r['id'], retry_unbound=True)
            for r in inbox(project, 'master') if r['status'] == 'undelivered']


def document_updated(project, terminal, filename, path):
    """Save already succeeded; all notification failures become delivery status."""
    deliveries = []
    for recipient in dict.fromkeys([terminal, 'master']):
        try:
            deliveries.append(send(project, 'user', recipient,
                f'{terminal} - user updated {filename}. Read the saved file before your next task: {path}. '
                'This is a document update notification; no acknowledgement is required.'))
        except Exception as exc:
            deliveries.append({'recipient': recipient, 'status': 'failed', 'detail': str(exc)})
    return deliveries


def _paths(project, paths):
    root = Path(project).resolve()
    values = []
    for item in paths:
        path = (root / item).resolve()
        if not path.is_relative_to(root):
            raise ValueError('Claim must stay inside the project')
        values.append(bridge.canonical(path))
    return sorted(set(values))


def claims(project):
    return bridge.read(bridge.state_for(project) / 'team' / 'claims.json', [])


def claim(project, agent, paths, task=''):
    agent = identity(project, agent)
    if agent == 'user':
        raise ValueError('Only agents claim work')
    paths = _paths(project, paths)
    if not paths:
        raise ValueError('At least one file or directory is required')
    path = bridge.state_for(project) / 'team' / 'claims.json'
    with bridge.Lock(bridge.canonical(project) + ':team-claims', True):
        existing = bridge.read(path, [])
        for value in paths:
            for entry in existing:
                a, b = Path(value), Path(entry['path'])
                if entry['agent'] != agent and (a.is_relative_to(b) or b.is_relative_to(a)):
                    raise ValueError(f"Claim conflict: {entry['agent']} owns {entry['path']}")
        existing = [entry for entry in existing if not (entry['agent'] == agent and entry['path'] in paths)]
        existing.extend(dict(agent=agent, path=value, task=task, claimed=time.time()) for value in paths)
        bridge.atomic(path, existing)
        return existing


def release(project, agent, paths=None):
    agent = identity(project, agent)
    selected = _paths(project, paths) if paths else None
    path = bridge.state_for(project) / 'team' / 'claims.json'
    with bridge.Lock(bridge.canonical(project) + ':team-claims', True):
        existing = bridge.read(path, [])
        remaining = [entry for entry in existing if not (entry['agent'] == agent and
                     (selected is None or entry['path'] in selected))]
        bridge.atomic(path, remaining)
        return remaining


def _session_metadata(record):
    """What the squad plugin recorded for this pane.

    OpenCode keeps model and token usage in its own session database rather than a
    readable per-pane transcript, so usage is reported as unavailable instead of
    being guessed at. Unavailable is not zero.
    """
    session = record.get('sessionID') if isinstance(record, dict) else None
    return {'model': None, 'provider': None, 'usage': None,
            'session': session if isinstance(session, str) and session.strip() else None}


def overview(project):
    root = bridge.state_for(project)
    cfg = bridge.config(project)
    owned = claims(project)
    master = bridge.read(root / 'relay/master.json')
    agents = [{'id': 'master', 'role': 'Master: coordination, review and integration',
               'status': 'registered' if master else 'not registered',
               'task': None, 'files': [c['path'] for c in owned if c['agent'] == 'master'],
               'model': None, 'provider': None, 'usage': None, 'result': None,
               'note': 'Registration does not confirm a live connection or running task.'}]
    for number in cfg['sessions']:
        agent = 'oc-' + number
        folder = root / agent
        worker = bridge.read(folder / 'worker.json', {'status': 'not started'})
        status = worker.get('status', 'unknown')
        try:
            with bridge.Lock(bridge.canonical(folder) + ':native-pane'):
                if status != 'not started':
                    status = 'stopped'
        except RuntimeError:
            pass
        running = sorted((folder / 'running').glob('*.json'))
        pending = sorted((folder / 'pending').glob('*.json'))
        results = sorted((folder / 'results').glob('*.json'))
        task = bridge.read(running[0] if running else pending[0], {}) if running or pending else {}
        latest = bridge.read(results[-1], {}) if results else {}
        item = {'id': agent, 'role': 'Worker: bounded implementation and verification',
                'status': status, 'task': str(task.get('prompt', ''))[:300] or None,
                'pending': len(pending), 'files': [c['path'] for c in owned if c['agent'] == agent],
                'result': ({'id': latest.get('id'), 'status': latest.get('status'),
                            'summary': str(latest.get('output') or latest.get('error') or '')[:1500]}
                           if latest else None)}
        item.update(_session_metadata(bridge.read(folder / 'session.json') or {}))
        agents.append(item)
    return {'agents': agents, 'usage': {'note': 'OpenCode records usage in its own session database, which this overview does not read. '
            'Missing values are unavailable, not zero. Model usage and billed costs are unavailable.'}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['send', 'message', 'claim', 'release', 'claims', 'inbox', 'flush', 'overview'])
    parser.add_argument('--project', required=True)
    parser.add_argument('--sender', '--from', dest='sender')
    parser.add_argument('--to')
    parser.add_argument('--text')
    parser.add_argument('--text-file')
    parser.add_argument('--request')
    parser.add_argument('--agent')
    parser.add_argument('--path', action='append', default=[])
    parser.add_argument('--task', default='')
    parser.add_argument('--compact', action='store_true', help='Print a short addressed receipt for terminal conversations')
    args = parser.parse_args()
    if args.command in ('send', 'message'):
        text = Path(args.text_file).read_text(encoding='utf-8-sig') if args.text_file else (args.text or '')
        value = send(args.project, args.sender, args.to, text, args.request)
    elif args.command == 'claim':
        value = claim(args.project, args.agent, args.path, args.task)
    elif args.command == 'release':
        value = release(args.project, args.agent, args.path)
    elif args.command == 'overview':
        value = overview(args.project)
    elif args.command == 'inbox':
        value = inbox(args.project, args.agent)
    elif args.command == 'flush':
        value = flush(args.project)
    else:
        value = claims(args.project)
    if args.compact and args.command in ('send', 'message'):
        print(f"@{value['sender']} -> @{value['recipient']} [{value['status']}; {value['id']}]: {value['text']}")
    else:
        print(json.dumps(value, ensure_ascii=True))


if __name__ == '__main__':
    main()

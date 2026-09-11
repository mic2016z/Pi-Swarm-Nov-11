"""Local OpenCode squad queue/console. No network server, account handling or model overrides."""
import argparse
import ctypes
import hashlib
import json
import os
import re
if os.name == 'nt':
    import msvcrt
else:
    import fcntl
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid
from ctypes import wintypes
_thread_locks = {}
_thread_locks_guard = threading.Lock()
# Seed for a project that has never recorded a launch model. Every pane uses the saved id.
DEFAULT_MODEL = 'opencode/big-pickle'
# Each pane is a full OpenCode runtime, so the default squad is small. Raise it
# with SQUAD_PANES, or add panes at runtime; 24 at once exhausts a normal machine.
DEFAULT_PANES = max(1, min(24, int(os.environ.get("SQUAD_PANES") or 3)))
# Fixed roles for the first three panes, so the squad behaves like a small
# development team rather than three interchangeable workers.
SQUAD_ROLES = {'1': 'UI designer', '2': 'Backend expert', '3': 'QA tester'}


def contain_process_tree():
    """Put this runner and future children in a kill-on-close Windows Job."""
    if os.name != 'nt':
        return None
    class Basic(ctypes.Structure):
        _fields_ = [('per_process', ctypes.c_longlong), ('per_job', ctypes.c_longlong), ('flags', wintypes.DWORD), ('min_ws', ctypes.c_size_t), ('max_ws', ctypes.c_size_t), ('active', wintypes.DWORD), ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
    class Io(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]
    class Extended(ctypes.Structure):
        _fields_ = [('basic', Basic), ('io', Io), ('process_memory', ctypes.c_size_t), ('job_memory', ctypes.c_size_t), ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]
    api = ctypes.WinDLL('kernel32', use_last_error=True)
    api.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    api.CreateJobObjectW.restype = wintypes.HANDLE
    api.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    api.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    api.GetCurrentProcess.restype = wintypes.HANDLE
    handle = api.CreateJobObjectW(None, None)
    info = Extended()
    info.basic.flags = 0x2000
    if not handle or not api.SetInformationJobObject(handle, 9, ctypes.byref(info), ctypes.sizeof(info)) or not api.AssignProcessToJobObject(handle, api.GetCurrentProcess()):
        raise OSError(ctypes.get_last_error(), 'Cannot contain the agent process tree; refusing unsafe launch')
    # Keep handle open until OS tears down the runner. Closing it early kills us too.
    return handle


def canonical(path):
    return os.path.normcase(str(Path(path).resolve()))


def state_for(project):
    key = hashlib.sha256(canonical(project).encode()).hexdigest()[:20]
    return Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'OpenCodeSquads' / key


def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    # Windows indexers/security scanners can briefly hold a just-written file.
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            break
        except PermissionError:
            if attempt == 19:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(.025)


def read(path, default=None):
    for attempt in range(20):
        try:
            return json.loads(Path(path).read_text(encoding='utf-8-sig'))
        except FileNotFoundError:
            return default
        except PermissionError:
            # Windows scanners can briefly hold a freshly published state file.
            if attempt == 19:
                raise
            time.sleep(.025)


class Lock:
    def __init__(self, identity, wait=False):
        root = Path(os.environ.get('LOCALAPPDATA', Path.home())) / 'OpenCodeSquads' / 'locks'
        root.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha256(identity.encode()).hexdigest()
        with _thread_locks_guard:
            self.local = _thread_locks.setdefault(key, threading.Lock())
        if not self.local.acquire(timeout=10 if wait else 0):
            raise RuntimeError('Session already owned or active: ' + identity)
        self.file = open(root / (key + '.lock'), 'a+b')
        self.file.seek(0)
        try:
            if os.name == 'nt':
                msvcrt.locking(self.file.fileno(), msvcrt.LK_LOCK if wait else msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        except OSError:
            self.file.close()
            self.local.release()
            raise RuntimeError('Session already owned or active: ' + identity)

    def close(self):
        self.file.seek(0)
        if os.name == 'nt':
            msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
        self.file.close()
        self.local.release()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def config(project):
    root = state_for(project)
    path = root / 'config.json'
    with Lock(canonical(path), True):
        cfg = read(path)
        if cfg is None:
            if not Path(project).is_dir():
                raise ValueError('Project must be an existing folder')
            cfg = {'project': str(Path(project).resolve()), 'sessions': {str(i): None for i in range(1, DEFAULT_PANES + 1)},
                   'default_model': DEFAULT_MODEL, 'github_repo': ''}
            atomic(path, cfg)
        return cfg


def agent_dir(project, agent):
    if str(agent) not in config(project)['sessions']:
        raise ValueError('Unknown squad agent')
    root = state_for(project) / f'oc-{agent}'
    for folder in ('pending', 'running', 'results', 'events'):
        (root / folder).mkdir(parents=True, exist_ok=True)
    return root


def add_agent(project):
    cfg = config(project)
    path = state_for(project) / 'config.json'
    with Lock(canonical(path), True):
        cfg = read(path)
        number = max(map(int, cfg['sessions'])) + 1
        cfg['sessions'][str(number)] = None
        atomic(path, cfg)
    return number


def validated_model(value):
    """Accept only an exact provider/model id; reject flag-like values outright."""
    if not isinstance(value, str) or not value.strip() or value.startswith('-') or '/' not in value:
        raise ValueError('Invalid default_model: use provider/model, for example opencode/big-pickle')
    return value.strip()


def default_model(project):
    """Last saved launch model, shared by the master and every worker pane."""
    return validated_model(config(project).get('default_model') or DEFAULT_MODEL)


def agent_model(project, agent=None):
    """A pane may override the project model; otherwise it uses the project default."""
    if agent is not None:
        override = (config(project).get('agent_models') or {}).get(str(agent))
        if override:
            return validated_model(override)
    return default_model(project)


# Agents run unattended, so permission prompts would stall a pane with nobody
# to answer them. --auto approves anything not explicitly denied: the squad can
# edit files and run commands without asking. Set SQUAD_AUTO=0 to require prompts.
AUTO_APPROVE = os.environ.get('SQUAD_AUTO', '1') not in ('0', 'false', 'no')


def launch_flags():
    return ['--auto'] if AUTO_APPROVE else []


def model_args(project, agent=None):
    """Passed explicitly on every launch so panes never inherit the user's global default."""
    return ['--model', agent_model(project, agent)] + launch_flags()


def configure_agent_model(project, agent, model):
    """Record one pane's model. It applies when that pane next starts."""
    model = validated_model(model)
    target = state_for(project) / 'config.json'
    config(project)
    with Lock(canonical(target), True):
        cfg = read(target)
        models = dict(cfg.get('agent_models') or {})
        models[str(agent)] = model
        cfg['agent_models'] = models
        atomic(target, cfg)
    return {'agent': str(agent), 'model': model}


def validated_repo(value):
    """Accept an https URL or owner/name; reject anything that could become a flag."""
    value = (value or '').strip().rstrip('/')
    if not value:
        return ''
    if value.startswith('-'):
        raise ValueError('Repository must not begin with "-"')
    if value.startswith('https://') or value.startswith('git@'):
        return value
    if re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', value):
        return 'https://github.com/' + value
    raise ValueError('Use https://github.com/owner/name or owner/name')


def detect_repo(project):
    """The project's own origin remote, so a new folder brings its own repository."""
    try:
        found = subprocess.run(['git', '-C', str(project), 'remote', 'get-url', 'origin'],
                               capture_output=True, text=True, encoding='utf-8', timeout=20)
        if found.returncode == 0:
            return validated_repo(found.stdout.strip())
    except Exception:
        pass  # No git, no remote, or not a repository: an empty field is the honest answer.
    return ''


def github_repo(project):
    """Configured repository, else whatever this folder's git origin points at."""
    stored = config(project).get('github_repo')
    if stored:
        try:
            return validated_repo(stored)
        except ValueError:
            return ''
    return detect_repo(project)


def configure_repo(project, repo):
    """Record the shared repository every agent pushes branches to."""
    repo = validated_repo(repo)
    config(project)
    target = state_for(project) / 'config.json'
    with Lock(canonical(target), True):
        cfg = read(target)
        cfg['github_repo'] = repo
        atomic(target, cfg)
    return {'github_repo': repo, 'applies': 'immediately; agents read it from their instructions'}


def discover_providers():
    """Group the installed OpenCode catalog by provider, for the pane model menus.

    Nothing is hardcoded: the list is whatever this machine's subscriptions
    actually expose. Display names come from the resolved config where the user
    has named a provider, and fall back to the id otherwise.
    """
    catalog = subprocess.run([*opencode_command(), 'models'],
                             capture_output=True, text=True, encoding='utf-8', timeout=180, check=True)
    # Built-in providers are not in the config, so name the well-known ones.
    names = {'opencode': 'OpenCode Zen'}
    try:
        resolved = subprocess.run([*opencode_command(), 'debug', 'config'],
                                  capture_output=True, text=True, encoding='utf-8', timeout=180, check=True)
        for key, value in (json.loads(resolved.stdout).get('provider') or {}).items():
            if isinstance(value, dict) and value.get('name'):
                names[key] = value['name']
    except Exception:
        pass  # Named providers are a nicety; the ids alone still make a usable menu.

    groups = {}
    for line in catalog.stdout.splitlines():
        line = line.strip()
        if not line or line.startswith('-') or '/' not in line:
            continue
        provider, _, model = line.partition('/')
        # The dialog matches on the model name, so that is what gets typed into it.
        groups.setdefault(provider, []).append({'label': model, 'filter': model, 'id': line})

    providers = [{'label': names.get(key, key), 'models': sorted(models, key=lambda m: m['label'])}
                 for key, models in groups.items()]
    providers.sort(key=lambda p: (-len(p['models']), p['label'].lower()))
    return {'providers': providers}


def configure_model(project, model):
    """Validate against the installed OpenCode catalog before staging the next launch."""
    model = validated_model(model)
    catalog = subprocess.run([*opencode_command(), 'models'],
                             capture_output=True, text=True, encoding='utf-8', timeout=120, check=True)
    if model not in {line.strip() for line in catalog.stdout.splitlines()}:
        raise ValueError('Model is not in the installed OpenCode catalog: ' + model)
    config(project)
    target = state_for(project) / 'config.json'
    with Lock(canonical(target), True):
        cfg = read(target)
        cfg['default_model'] = model
        atomic(target, cfg)
    return {'default_model': model, 'applies': 'next master and worker launch'}


def initialize_project(project):
    config(project)
    root = state_for(project)
    path = root / 'config.json'
    with Lock(canonical(path), True):
        cfg = read(path)
        for number in range(1, DEFAULT_PANES + 1):
            cfg['sessions'].setdefault(str(number), None)
        cfg['default_model'] = validated_model(cfg.get('default_model') or DEFAULT_MODEL)
        atomic(path, cfg)
    legacy_docs = root / 'instructions'
    if legacy_docs.is_dir():
        for folder in legacy_docs.iterdir():
            if not folder.is_dir():
                continue
            destination = Path(project).resolve() / SQUAD_DIR / folder.name
            if destination.exists():
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(folder), str(destination))
    ensure_documents(project)
    return cfg


def enqueue(project, agent, prompt, source='task'):
    if not prompt.strip():
        raise ValueError('Prompt is empty')
    root = agent_dir(project, agent)
    with Lock(canonical(root) + ':queue', True):
        counter = root / 'sequence.json'
        seq = read(counter, 0) + 1
        atomic(counter, seq)
        job_id = f'{seq:012d}'
        atomic(root / 'pending' / (job_id + '.json'), {'id': job_id, 'agent': agent, 'prompt': prompt, 'source': source, 'submitted': time.time()})
    return job_id


DOCUMENT_NAMES = ('agent.md', 'context.md', 'todo.md')
# Kept beside the code so a project carries its own squad configuration.
SQUAD_DIR = '.squad'
DOCUMENT_LIMIT = 128 * 1024


SPECIALITIES = {
    'UI designer': (
        'You own the interface: layout, styling, accessibility and interaction. Prefer the smallest change that '
        'makes the screen clearer. Keep contrast and keyboard access intact, and never let a visual tweak alter '
        'behaviour silently.'),
    'Backend expert': (
        'You own the engine: data flow, state, correctness, error handling and performance. Prefer explicit '
        'failures to silent fallbacks, and report a value as unavailable rather than defaulting it to zero. Keep '
        'public interfaces stable unless the assignment says otherwise.'),
    'QA tester': (
        'You own verification. Write and run Playwright smoke tests in headed mode, so a real browser is driven '
        'visibly: click the actual controls, type into the real fields, and assert what a user would see. Report '
        'the actual output of the run, including failures, and never describe an unverified path as passing. '
        'Include the failing selector or error text so it can be acted on.'),
}


def document_path(project, terminal, filename):
    if terminal != 'master' and terminal not in {'oc-' + n for n in config(project)['sessions']}:
        raise ValueError('Unknown terminal')
    if filename == 'todol.md':  # Compatibility for older app builds.
        filename = 'todo.md'
    if filename not in DOCUMENT_NAMES:
        raise ValueError('Choose agent.md, context.md or todo.md')
    # Instructions live with the project, not in per-machine state: they describe
    # this codebase's squad, so they travel with the folder and can be committed.
    root = Path(project).resolve()
    target = root / SQUAD_DIR / terminal / filename
    # Inspect unresolved components: resolving first would hide symlinks/junctions.
    for part in (root, root / SQUAD_DIR, target.parent, target):
        if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
            raise ValueError('Instruction paths cannot be symlinks or junctions')
    # Both terminal and filename are allowlisted, and every constructed component
    # rejects symlinks/junctions above. Do not compare resolved parents: MSIX
    # virtualization can redirect individual files independently of their folder.
    return target


def default_document(project, terminal, filename):
    folder = state_for(project) / 'instructions' / terminal
    if filename == 'context.md':
        return (f'# Working memory\n\nProject: {Path(project).resolve()}\nAgent: {terminal}\n\n'
                'Durable notes that outlive a session. Long conversations get compacted, and anything you '
                'learned the hard way goes with them unless it is written down here.\n\n'
                '## Record\n'
                '- Facts you verified: the exact command that builds or tests this project, a path that is not '
                'where it looks, an interface that returns null rather than zero.\n'
                '- Decisions and the reason for them, so they are not relitigated.\n'
                '- Traps: something that looks correct and is not.\n\n'
                '## Keep it honest\n'
                'Only verified findings. When a fact turns out to be wrong, replace it rather than adding a '
                'contradiction, and delete what has gone stale. Short and current beats long and historical.\n')
    if filename == 'todo.md':
        return ('# Standing instructions\n\n'
                'This file belongs to the user, not to the agent. It is a queue of work to get on with, so a '
                'direction can be set once and picked up later.\n\n'
                '## For the user\n'
                'One instruction per line as a checklist item. They are worked from the top down.\n\n'
                '- [ ] First thing to do\n'
                '- [ ] Then this\n\n'
                '## For the agent\n'
                'Read this file before asking what to do next. Take the topmost unchecked item that falls within '
                'your role and treat it as an assignment; if it has no acceptance check, decide one and say what '
                'it is.\n'
                'Mark an item [x] only once that check has actually passed, and append the evidence in one short '
                'line. Never delete or reword a user item, and do not add items of your own: your own findings '
                'belong in GitHub issues.\n')
    files_section = (
        '## Your three files\n'
        'The burger menu on your terminal opens these, and the user can edit any of them.\n'
        '- agent.md: who you are and how you work. Read it first. The user edits it to change your behaviour, so '
        're-read it if your instructions appear to have changed.\n'
        '- context.md: your own durable memory. Long sessions get compacted; anything that must survive that has '
        'to be written here. Record verified findings and decisions, not narration.\n'
        '- todo.md: the user standing instruction queue. Check it when you need direction, work the topmost '
        'unchecked item in your role, and mark it [x] only once its check has passed with squad_tasks. The user '
        'owns the file and the master may append assignments to it; never delete or reword an item, and raise '
        'your own findings as GitHub issues instead.\n\n')
    common = (f'Project: {Path(project).resolve()}\nFiles: {folder}\n'
              'Read agent.md and context.md before a task, and todo.md when you need direction. Keep context factual and short.\n'
              'Use stable oc-N/master IDs. Reserve files before edits; preserve peer changes. Ask the owner before overlapping edits, and release reservations on completion.\n'
              'Stay idle without model calls when unassigned. No heartbeat, acknowledgement-only or duplicate messages. Visible output is concise findings, actions and evidence, not private internal reasoning.\n')
    roster = ', '.join('oc-' + n for n in sorted(config(project)['sessions'], key=int))
    repo = github_repo(project) or '(not set: ask the user to paste the repository link in the app)'
    number = terminal.split('-')[-1]
    if terminal == 'master':
        role = (
            '# Squad master (orchestrator and maintainer)\n\n'
            f'You are the master of a small development team on this project. Workers: {roster}. '
            f'Shared repository: {repo}\n\n'
            'Every pane runs the same user-configured model; never assume which model you or a peer is running. '
            'Requests from outside conversations arrive over the native relay/MCP transport, and your final reply '
            'to such a request is published back to its receipt.\n\n'
            '## Your standards\n'
            'You are a hard marker. The default answer to "is this good enough" is no, until the evidence says '
            'otherwise. Mediocre work shipped quietly is the failure mode you exist to prevent.\n'
            '- Demand evidence. "It works" is not a result; the command and its actual output are. Claims without '
            'output are rejected, not chased.\n'
            '- Attack complexity. Ask what each piece is for, and whether the change could be half the size. A '
            'simpler correct solution beats a clever one every time. If you cannot explain why something exists, '
            'it should not.\n'
            '- Send work back with one specific reason and one concrete expectation. "This is not good enough" is '
            'useless on its own; name the defect and what would fix it.\n'
            '- Do not soften a real problem to keep the peace, and do not praise routine work. When something is '
            'genuinely good, say so once, plainly, and move on.\n'
            '- Be ruthless about the work and fair to the worker. Criticise the code, the design and the '
            'evidence; never the agent. Sarcasm and contempt are not standards, they are noise.\n'
            '- Change your mind when you are shown you are wrong, and say so directly. Being right matters more '
            'than having been right.\n\n'
            '## Your authority\n'
            'You are the only agent permitted to commit or merge to main. Workers open pull requests; you review '
            'and merge them. Never push a worker branch yourself, and never merge a change without running its '
            'acceptance command first.\n\n'
            '## Orchestration\n'
            'Your job is orchestration, not implementation. Decompose, dispatch, review, merge and decide. Take a '
            'task yourself only when it is narrow, hard and blocking, or when no worker is free.\n'
            '1. Cut work into independent slices so two workers rarely touch the same file. Shared contracts '
            '(types, schemas, interfaces, test scaffolding) are one slice and must land first.\n'
            '2. Every assignment states: the goal, the files the worker may touch, its dependencies, a concrete '
            'acceptance command that must exit zero, and the result format. An assignment without an acceptance '
            'command is not ready to send.\n'
            '3. Match the slice to the role: interface work to oc-1, engine work to oc-2, verification to oc-3. '
            'Use only as many workers as there are genuinely independent slices. Idle workers cost nothing; '
            'invented busywork costs correctness. Respect memory and provider rate limits: reduce concurrency '
            'when throttled rather than retrying harder.\n\n'
            '## Dispatching a batch\n'
            'Prefer batches over one-off messages. squad_tasks(action="assign", to="oc-1", tasks=[...]) appends '
            'about five tasks to that worker list and pings it. Each line states the goal and its acceptance '
            'check, because a task without a check is not ready to send.\n'
            'Assigning pings the worker for you: it is told its list changed and asked to report back for code '
            'review when the work is done. Never change a list silently, or it sits unread.\n'
            'The worker then pulls its own way through the list without waiting on you, and messages you when '
            'the list is empty. Top it up, or say there is nothing further and let it idle.\n'
            'squad_tasks(action="read", agent="oc-1") shows the current list and what is already ticked. Items '
            'the user wrote are theirs: never reword or remove them, only append below.\n\n'
            '## Review, integration and the record\n'
            'You are the only agent that touches git history or GitHub, which keeps the record coherent and '
            'stops four agents narrating the same change.\n'
            '- A worker reports that its tasks are done. Review the actual diff yourself and run the acceptance '
            'check. A worker reporting success is not evidence.\n'
            '- If it is good, commit and push it. If it is not, send back one specific correction rather than a '
            'general complaint.\n'
            '- Document the work on GitHub yourself: an issue or a short write-up of what changed and why. Do '
            'this once, after integrating, so there is one account of each change rather than four.\n'
            '- Read logs/oc-N.md when you need to know what a worker actually did; it is the full transcript of '
            'that session and survives compaction.\n'
            'Pull requests are optional. Use them when a change genuinely needs a second opinion or an audit '
            'trail, and skip them when they only add ceremony.\n\n'
            '## Reporting\n'
            'Summarise as CHANGED / CHECKS / RISKS / NEXT. Report failures and blockers plainly; never present '
            'unverified work as done.\n\n')
        commands = ('Tools: squad_roster(), squad_message(to, text), squad_claims(action, paths, task).\n'
                    'Dispatch: squad_tasks(action="assign", to="oc-1", tasks=["goal; allowed files; '
                    'acceptance command; result format").\n'
                    'Review: gh pr list, gh pr diff N, gh pr merge N --squash.\n')
    else:
        title = SQUAD_ROLES.get(number, 'Engineer')
        speciality = SPECIALITIES.get(title, 'You implement bounded slices and verify them.')
        role = (f'# {terminal} / {title}\n\n'
                f'{speciality}\n\n'
                f'Shared repository: {repo}. The master owns product direction, review and main.\n\n'
                '## Your spine\n'
                'You are not a yes-man. The master is a hard marker and expects work that survives scrutiny.\n'
                '- Never report success you have not verified. A failing check is reported as failing; a partial '
                'result is reported as partial. Being caught overstating once costs more than the delay.\n'
                '- Push back when you are asked for something wrong, unnecessary or needlessly complex. Say so '
                'plainly, give the concrete alternative, and give your reason. Doing bad work because you were '
                'told to is not obedience, it is a defect you helped ship.\n'
                '- Say "I do not know" rather than guessing, and say what you would need to find out.\n'
                '- Accept a correction without argument once the reasoning is sound, and without sulking. The '
                'work is the point, not who was right.\n\n'
                '## Accepting work\n'
                'Accept only a scoped assignment with a concrete goal, allowed files and an acceptance command. '
                'If essential scope is missing, ask one focused question; otherwise stay idle rather than '
                'guessing.\n\n'
                '## Your loop\n'
                '1. Claim your files: squad_claims(action="claim", paths=[...]). Writes to paths another agent '
                'holds are denied automatically, so claim before editing.\n'
                f'2. Branch: git checkout -b {terminal}/short-topic. Never commit to main; that is the master '
                'only.\n'
                '3. Implement, then run the acceptance command until it passes.\n'
                '4. Commit, push the branch, and open a pull request with gh pr create, referencing the issue. '
                'The body is CHANGED / CHECKS (actual command output) / RISKS / NEXT.\n'
                '5. Release your claims.\n\n'
                '## Working a task list\n'
                'Your list is todo.md and squad_tasks(action="read") shows it. Work the topmost unchecked item '
                'that falls within your role; do not wait to be told which one.\n'
                'When its check has passed, tick it with squad_tasks(action="done", item="...", '
                'evidence="the actual command output"). Only after the check has genuinely passed.\n'
                'When nothing unchecked remains, message the master once to say the list is empty and ask for '
                'more, then stay idle. Do not ask twice, and do not invent work to fill the gap.\n\n'
                '## Staying in your lane\n'
                'You do not touch git history or GitHub. No commits to main, no pushes, no pull requests, no '
                'issues. The master reviews your work, integrates it and writes the record, so the project has '
                'one account of each change rather than four.\n'
                'What you owe the master is evidence: what changed, the actual output of the acceptance check, '
                'and anything you are unsure about.\n'
                'Found a bug outside your slice, or a simpler and faster approach than the one you were given? '
                'Say so plainly to the master, with the concrete alternative and why it is better. Be direct '
                'about defects; vague agreement helps nobody. Criticise the code, never the agent. The master '
                'decides, and records it.\n\n'
                '## Escalating\n'
                'Diagnose locally first: reproduce, read the actual error, then try a materially different '
                'check. Ask for help after about two unsuccessful attempts rather than repeating equivalent '
                'retries. Escalate immediately for product decisions, conflicting ownership, irreversible risk, '
                'or missing essential context.\n\n')
        commands = ('Tools: squad_message(to, text), squad_claims(action, paths, task), squad_roster().\n'
                    'Task list: squad_tasks(action=read|done, item, evidence).\n'
                    'Ask for help: squad_message(to="master", text="HELP task: expected/observed; exact error '
                    'or file:line; tried/result; the specific question").\n')
    return role + files_section + common + '\n' + commands


def _document_content(path):
    try:
        with path.open('rb') as stream:
            raw = stream.read(DOCUMENT_LIMIT + 1)
        if len(raw) > DOCUMENT_LIMIT:
            raise ValueError('Document exceeds 128 KB')
        return raw.decode('utf-8-sig').replace('\r\n', '\n')
    except FileNotFoundError:
        return None


def _seed_document(project, terminal, path):
    content = _document_content(path)
    if content is not None:
        return content
    # Leave the legacy file intact; an existing todo.md always wins.
    legacy = path.with_name('todol.md')
    if path.name == 'todo.md' and legacy.exists():
        if legacy.is_symlink() or (hasattr(legacy, 'is_junction') and legacy.is_junction()):
            raise ValueError('Instruction paths cannot be symlinks or junctions')
        content = _document_content(legacy)
    if content is None:
        content = default_document(project, terminal, path.name)
    path.parent.mkdir(parents=True, exist_ok=True)
    document_path(project, terminal, path.name)
    # Exclusive creation protects an external writer that created the file meanwhile.
    try:
        with path.open('x', encoding='utf-8', newline='') as stream:
            stream.write(content)
    except FileExistsError:
        return _document_content(path)
    return content


def document_read(project, terminal, filename):
    path = document_path(project, terminal, filename)
    with Lock(canonical(project) + ':document:' + terminal + ':' + path.name, True):
        content = _seed_document(project, terminal, path)
    return {'path': str(path), 'content': content}


def ensure_documents(project):
    for terminal in ['master', *('oc-' + n for n in config(project)['sessions'])]:
        for filename in DOCUMENT_NAMES:
            document_read(project, terminal, filename)


def document_write(project, terminal, filename, content, expected):
    if not isinstance(content, str) or not isinstance(expected, str):
        raise ValueError('Content and original content must be strings')
    content = content.replace('\r\n', '\n')
    raw = content.encode('utf-8')
    if len(raw) > DOCUMENT_LIMIT:
        raise ValueError('Document exceeds 128 KB')
    path = document_path(project, terminal, filename)
    with Lock(canonical(project) + ':document:' + terminal + ':' + path.name, True):
        current = _document_content(path)
        if (current if current is not None else '') != expected:
            raise ValueError('File changed since opening. Copy your edits, then reopen the file before saving.')
        path.parent.mkdir(parents=True, exist_ok=True)
        document_path(project, terminal, filename)
        tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
        try:
            tmp.write_bytes(raw)
            for attempt in range(20):
                try:
                    os.replace(tmp, path)
                    break
                except PermissionError:
                    if attempt == 19:
                        raise
                    time.sleep(.025)
        finally:
            tmp.unlink(missing_ok=True)
    result = {'path': str(path), 'content': content}
    if current != content:
        try:
            from team import document_updated
            result['notifications'] = document_updated(project, terminal, path.name, str(path))
        except Exception as exc:
            result['notification_warning'] = 'Saved, but team notification could not be recorded: ' + str(exc)
    return result


def document_context(project, terminal):
    parts = []
    for filename in DOCUMENT_NAMES:
        doc = document_read(project, terminal, filename)
        if doc['content'].strip():
            parts.append(f"### {filename}\n{doc['content']}")
    roster = ', '.join('oc-' + n for n in sorted(config(project)['sessions'], key=int))
    parts.append('### Current team capacity\n'
                 f'One master coordinates {len(config(project)["sessions"])} OpenCode workers on this same project: {roster}. '
                 'Use only as many active workers as there are independent useful tasks and available machine/provider capacity. '
                 'Reduce concurrency on resource pressure or rate limits. Idle workers wait locally without model calls or polling prompts. '
                 'Claim files before editing. Send concise handovers: changes, tests/evidence, risks, next decision. '
                 'Report results and blockers to the master; message peers only when useful.')
    return '\n\n'.join(parts)


def prompt_with_documents(project, agent, prompt):
    context = document_context(project, f'oc-{agent}')
    if not context:
        return prompt
    return ('Current user-maintained agent instructions and context follow. '
            'These replace earlier versions of these documents; the current task below takes precedence.\n\n'
            + context + '\n\n### Current task\n' + prompt)



def opencode_command():
    """Resolve the OpenCode CLI. The launch model is passed explicitly per pane."""
    shim = shutil.which('opencode.cmd') or shutil.which('opencode')
    if not shim:
        raise RuntimeError('Install OpenCode and add it to PATH')
    return [shim]


def deploy_plugin(project):
    """OpenCode auto-loads .opencode/plugin/*.ts from the project, so publish ours there."""
    source = Path(__file__).resolve().with_name('squad-plugin.ts')
    target = Path(project) / '.opencode' / 'plugin' / 'squad.ts'
    target.parent.mkdir(parents=True, exist_ok=True)
    text = source.read_text(encoding='utf-8')
    if not target.exists() or target.read_text(encoding='utf-8') != text:
        target.write_text(text, encoding='utf-8')
    return target


def session_args(project, agent):
    """Resume this pane's OpenCode session when the plugin has recorded one."""
    record = read(state_for(project) / f'oc-{agent}' / 'session.json')
    session = (record or {}).get('sessionID')
    if not isinstance(session, str) or not session.strip() or session.startswith('-'):
        return []
    if not session.startswith('ses_'):
        return []  # A message id here would make OpenCode exit with "Invalid session ID".
    return ['--session', session]


def squad_env(project, agent):
    return {'SQUAD_PROJECT': str(Path(project).resolve()),
            'SQUAD_AGENT': str(agent),
            'SQUAD_ROOT': str(state_for(project) / ('oc-master' if agent == 'master' else f'oc-{agent}'))}


def say(text, end='\n'):
    try:
        print(text, end=end, flush=True)
    except (OSError, BrokenPipeError):
        pass  # A detached view must not release execution ownership early.


def run_job(project, agent, job_id):
    job_handle = contain_process_tree()
    root = agent_dir(project, agent)
    # This separate process holds the execution lock even if its worker/view exits.
    # Locks key on the agent's state directory: OpenCode sessions are database ids,
    # not files, so there is no session path to arbitrate.
    with Lock(canonical(root) + ':execution'):
        job_path = root / 'running' / (job_id + '.json')
        job = read(job_path)
        if job is None:
            raise ValueError('Missing claimed job')
        started = time.time()
        output = []
        code = -1
        error = None
        prompt_file = root / 'running' / (job_id + '.prompt.txt')
        say(f"\n[{job['source']}] {job['prompt']}\n\nPi {agent} > ", end='')
        try:
            prompt_file.write_text(prompt_with_documents(project, agent, job['prompt']), encoding='utf-8')
            # @file avoids Windows command length/quoting issues and preserves newlines.
            cmd = (opencode_command() + ['run', '--format', 'json'] + model_args(project)
                   + session_args(project, agent)
                   + [prompt_file.read_text(encoding='utf-8')])
            with open(root / 'events' / (job_id + '.jsonl'), 'w', encoding='utf-8') as log:
                proc = subprocess.Popen(cmd, cwd=project, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                atomic(root / 'active.json', {'runner': os.getpid(), 'pi': proc.pid, 'job': job_id})
                try:
                    for line in proc.stdout:
                        log.write(line)
                        log.flush()
                        try:
                            event = json.loads(line)
                        except ValueError:
                            say(line, end='')
                            continue
                        if event.get('type') == 'message_update':
                            update = event.get('assistantMessageEvent', {})
                            if update.get('type') == 'text_delta':
                                chunk = update.get('delta', '')
                                output.append(chunk)
                                say(chunk, end='')
                        elif event.get('type') == 'tool_execution_start':
                            say('\n[tool] ' + event.get('toolName', '?'))
                        elif event.get('type') == 'message_end':
                            message = event.get('message', {})
                            if message.get('role') == 'assistant' and message.get('stopReason') in ('error', 'aborted'):
                                error = message.get('errorMessage', message.get('stopReason'))
                        elif event.get('type') == 'error':
                            error = str(event)
                    code = proc.wait()
                except BaseException:
                    proc.terminate()
                    proc.wait()
                    raise
        except BaseException as exc:
            error = str(exc) or type(exc).__name__
        finally:
            result = {**job, 'started': started, 'completed': time.time(), 'exit_code': code, 'status': 'success' if code == 0 and not error else 'failed', 'error': error, 'output': ''.join(output)}
            atomic(root / 'results' / (job_id + '.json'), result)
            job_path.unlink(missing_ok=True)
            prompt_file.unlink(missing_ok=True)
            (root / 'active.json').unlink(missing_ok=True)
        say(f"\n[{result['status']}; job {job_id}]" + (' ' + error if error else ''))


def worker(project, agent):
    root = agent_dir(project, agent)
    with Lock(canonical(root) + ':owner'):
        with Lock(canonical(root) + ':execution'):
            for path in (root / 'running').glob('*.json'):
                job = read(path)
                atomic(root / 'results' / path.name, {**job, 'status': 'interrupted', 'error': 'Previous worker stopped; not replayed', 'output': ''})
                path.unlink()
        (root / 'stop').unlink(missing_ok=True)
        atomic(root / 'worker.json', {'pid': os.getpid(), 'status': 'idle'})
        say(f'OpenCode {agent}  /  configured default model\nProject: {project}\nType a prompt and Enter. /stop exits after current work.\n')

        def terminal_input():
            while True:
                try:
                    line = input()
                    if line.strip() == '/stop':
                        (root / 'stop').touch()
                        return
                    if line.strip():
                        ident = enqueue(project, agent, line, 'terminal')
                        say('[queued ' + ident + ']')
                except EOFError:
                    return
        threading.Thread(target=terminal_input, daemon=True).start()
        try:
            while not (root / 'stop').exists():
                jobs = sorted((root / 'pending').glob('*.json'))
                if not jobs:
                    time.sleep(.2)
                    continue
                path = jobs[0]
                target = root / 'running' / path.name
                os.replace(path, target)
                atomic(root / 'worker.json', {'pid': os.getpid(), 'status': 'busy', 'job': path.stem})
                proc = subprocess.Popen([sys.executable, '-u', str(Path(__file__).resolve()), 'run-job', '--project', project, '--agent', str(agent), '--job', path.stem])
                try:
                    proc.wait()
                except KeyboardInterrupt:
                    say('Waiting for active Pi to stop safely...')
                    proc.wait()
                    break
                if not (root / 'results' / path.name).exists():
                    say('[error] Runner exited without result; restart will mark interrupted.')
                    break
                atomic(root / 'worker.json', {'pid': os.getpid(), 'status': 'idle'})
        finally:
            atomic(root / 'worker.json', {'pid': os.getpid(), 'status': 'stopped'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['init', 'add', 'submit', 'worker', 'native-worker', 'run-job', 'results', 'status', 'stop', 'document-read', 'document-write', 'document-context', 'configure-model', 'list-models', 'current-model', 'set-repo', 'current-repo', 'set-agent-model', 'discover-models'])
    parser.add_argument('--provider')
    parser.add_argument('--model')
    parser.add_argument('--repo')
    parser.add_argument('--project', required=True)
    parser.add_argument('--agent', type=int, default=1)
    parser.add_argument('--prompt')
    parser.add_argument('--prompt-file')
    parser.add_argument('--terminal')
    parser.add_argument('--filename')
    parser.add_argument('--job')
    parser.add_argument('--after', default='')
    args = parser.parse_args()
    project = str(Path(args.project).resolve())
    cfg = config(project)
    if args.command == 'discover-models':
        print(json.dumps(discover_providers()))
    elif args.command == 'set-agent-model':
        print(json.dumps(configure_agent_model(project, args.agent, args.model)))
    elif args.command == 'set-repo':
        print(json.dumps(configure_repo(project, args.repo)))
    elif args.command == 'current-repo':
        print(json.dumps({'github_repo': github_repo(project)}))
    elif args.command == 'list-models':
        catalog = subprocess.run([*opencode_command(), 'models'], capture_output=True, text=True,
                                 encoding='utf-8', timeout=120, check=True)
        print(json.dumps(sorted({line.strip() for line in catalog.stdout.splitlines()
                                 if line.strip() and '/' in line and not line.startswith('-')})))
    elif args.command == 'current-model':
        print(json.dumps({'model': default_model(project)}))
    elif args.command == 'configure-model':
        print(json.dumps(configure_model(project, args.model)))
    elif args.command == 'document-read':
        print(json.dumps(document_read(project, args.terminal, args.filename)))
    elif args.command == 'document-write':
        data = json.load(sys.stdin)
        print(json.dumps(document_write(project, args.terminal, args.filename, data['content'], data['expected'])))
    elif args.command == 'document-context':
        print(document_context(project, args.terminal))
    elif args.command == 'init':
        print(json.dumps(initialize_project(project)))
    elif args.command == 'add':
        number = add_agent(project)
        ensure_documents(project)
        print(number)
    elif args.command == 'submit':
        prompt = Path(args.prompt_file).read_text(encoding='utf-8-sig') if args.prompt_file else args.prompt
        print(enqueue(project, args.agent, prompt or ''))
    elif args.command == 'native-worker':
        from native_session import run
        run(project, args.agent)
    elif args.command == 'worker':
        worker(project, args.agent)
    elif args.command == 'run-job':
        run_job(project, args.agent, args.job)
    elif args.command == 'results':
        root = agent_dir(project, args.agent)
        for path in sorted((root / 'results').glob('*.json')):
            if path.stem > args.after:
                print(json.dumps(read(path), ensure_ascii=False))
    elif args.command == 'status':
        statuses = {}
        for a in cfg['sessions']:
            item = read(agent_dir(project, a) / 'worker.json', {'status': 'not started'})
            try:
                with Lock(canonical(agent_dir(project, a)) + ':native-pane'):
                    if item['status'] != 'not started':
                        item['status'] = 'stopped'
            except RuntimeError:
                pass
            statuses[a] = item
        print(json.dumps(statuses))
    elif args.command == 'stop':
        (agent_dir(project, args.agent) / 'stop').touch()


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Bridge error: ' + str(exc), file=sys.stderr)
        sys.exit(1)

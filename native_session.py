"""Supervises one native interactive OpenCode pane; terminal bytes pass untouched.

OpenCode keeps sessions in its own database keyed by id rather than in a file per
pane, so there is no session-file ownership handshake here. The single guarantee
this supervisor provides is that one agent id has one live pane.
"""
import os
from pathlib import Path
import subprocess
import sys

from bridge import (Lock, agent_dir, atomic, canonical, contain_process_tree, deploy_plugin,
                    model_args, opencode_command, read, session_args, squad_env)


def run(project, agent):
    root = agent_dir(project, agent)
    # The pane lock prevents a second supervisor claiming the same agent id.
    with Lock(canonical(root) + ':native-pane'):
        job_handle = contain_process_tree()
        for old in (root / 'running').glob('*.json'):
            job = read(old)
            atomic(root / 'results' / old.name,
                   {**job, 'status': 'interrupted', 'output': '', 'error': 'Native session restarted; not replayed'})
            old.unlink()
        (root / 'stop').unlink(missing_ok=True)
        atomic(root / 'worker.json', {'pid': os.getpid(), 'status': 'starting', 'mode': 'native'})

        deploy_plugin(project)
        env = {**os.environ, **squad_env(project, agent),
               'SQUAD_PYTHON': sys.executable,
               'SQUAD_BRIDGE': str(Path(__file__).with_name('bridge.py'))}
        # --session resumes the id the plugin recorded on a previous launch; on the
        # first run it is absent and OpenCode creates one, which the plugin saves.
        cmd = [*opencode_command(), *model_args(project, agent), *session_args(project, agent)]

        proc = None
        try:
            # Inherit the real terminal. No print/json mode, redirected stdin, or input() loop.
            if os.name == 'nt':
                # PowerShell requests Win32 key events; the TUI expects ordinary terminal input.
                sys.stdout.write('\x1b[?9001l')
                sys.stdout.flush()
            proc = subprocess.Popen(cmd, cwd=project, env=env)
            while proc.poll() is None:
                try:
                    proc.wait(timeout=.25)
                except (subprocess.TimeoutExpired, KeyboardInterrupt):
                    continue
        finally:
            if proc and proc.poll() is None:
                proc.terminate()
                proc.wait()
            atomic(root / 'worker.json', {'pid': os.getpid(), 'status': 'stopped', 'mode': 'native'})
            if os.name == 'nt':
                sys.stdout.write('\x1b[?9001h')
                sys.stdout.flush()
        return job_handle

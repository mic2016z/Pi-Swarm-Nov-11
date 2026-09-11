import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'LOCALAPPDATA': self.temp.name})
        self.env.start()
        self.project = str(Path(self.temp.name) / 'project')
        Path(self.project).mkdir()
    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()
    def test_project_and_agent_isolation(self):
        other = str(Path(self.temp.name) / 'other')
        Path(other).mkdir()
        first = bridge.config(self.project)
        second = bridge.config(other)
        # OpenCode assigns session ids at runtime, so isolation is by state directory
        # and by the agent slots a project owns, not by distinct session file paths.
        self.assertNotEqual(bridge.state_for(self.project), bridge.state_for(other))
        self.assertEqual(len(first['sessions']), bridge.DEFAULT_PANES)
        self.assertEqual(sorted(first['sessions'], key=int), sorted(second['sessions'], key=int))
        self.assertTrue(all(value is None for value in first['sessions'].values()))
        self.assertEqual(bridge.config(self.project), first)
    def test_atomic_fifo_and_literal_prompt(self):
        prompt = 'quotes " ; $(echo nope)\nUnicode: Ï€ and emoji ðŸŽ¹'
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            ids = list(pool.map(lambda i: bridge.enqueue(self.project, 1, prompt + str(i)), range(12)))
        root = bridge.agent_dir(self.project, 1)
        jobs = sorted((root / 'pending').glob('*.json'))
        self.assertEqual([p.stem for p in jobs], sorted(ids))
        self.assertEqual(len(set(ids)), 12)
        self.assertTrue(all(bridge.read(p)['prompt'].startswith(prompt) for p in jobs))
        self.assertFalse(list(root.rglob('*.tmp')))
    def test_duplicate_owner_excluded_across_processes(self):
        identity = 'unique-' + self.temp.name
        with bridge.Lock(identity):
            code = 'import bridge; bridge.Lock(' + repr(identity) + ')'
            result = subprocess.run([sys.executable, '-c', code], cwd=Path(bridge.__file__).parent, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
        with bridge.Lock(identity):
            pass
    def test_add_retains_existing_sessions(self):
        original = bridge.config(self.project)
        self.assertEqual(bridge.add_agent(self.project), bridge.DEFAULT_PANES + 1)
        current = bridge.config(self.project)
        for number, path in original['sessions'].items():
            self.assertEqual(current['sessions'][number], path)
    def test_initialize_adds_default_panes_preserving_existing_and_extras(self):
        path = bridge.state_for(self.project) / 'config.json'
        original = {'1': str(Path(self.temp.name) / 'custom.jsonl'),
                    '4': 'existing-four.jsonl', '29': 'extra-worker.jsonl'}
        bridge.atomic(path, {'project': self.project, 'sessions': original})
        cfg = bridge.initialize_project(self.project)
        self.assertTrue(all(str(i) in cfg['sessions'] for i in range(1, bridge.DEFAULT_PANES + 1)))
        for key, value in original.items():
            self.assertEqual(cfg['sessions'][key], value)
        # Every default slot exists, and slots outside the default range survive.
        expected = {str(i) for i in range(1, bridge.DEFAULT_PANES + 1)} | set(original)
        self.assertEqual(set(cfg['sessions']), expected)
        self.assertEqual(bridge.initialize_project(self.project), cfg)
    def test_interrupted_job_not_replayed(self):
        root = bridge.agent_dir(self.project, 1)
        ident = bridge.enqueue(self.project, 1, 'must not execute')
        os.replace(root / 'pending' / (ident + '.json'), root / 'running' / (ident + '.json'))
        # Stop worker after it initializes and quarantines stale running entries.
        proc = subprocess.Popen([sys.executable, str(Path(bridge.__file__)), 'worker', '--project', self.project, '--agent', '1'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        out, err = proc.communicate('/stop\n', timeout=10)
        self.assertEqual(proc.returncode, 0, out + err)
        self.assertEqual(bridge.read(root / 'results' / (ident + '.json'))['status'], 'interrupted')
        self.assertFalse(list((root / 'pending').glob('*.json')))
    def test_runner_containment_kills_child(self):
        code = 'import bridge,subprocess,sys,time; h=bridge.contain_process_tree(); p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"]); print(p.pid,flush=True); time.sleep(60)'
        proc = subprocess.Popen([sys.executable, '-u', '-c', code], cwd=Path(bridge.__file__).parent, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        child_pid = int(proc.stdout.readline().strip())
        from ctypes import WinDLL
        from ctypes import wintypes
        api = WinDLL('kernel32')
        api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        api.OpenProcess.restype = wintypes.HANDLE
        api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = api.OpenProcess(0x100000, False, child_pid)
        self.assertTrue(handle)
        try:
            proc.terminate()
            proc.wait(timeout=10)
            self.assertEqual(api.WaitForSingleObject(handle, 5000), 0, 'Pi-like child survived runner death')
        finally:
            api.CloseHandle(handle)
            proc.stdout.close()
            proc.stderr.close()


if __name__ == '__main__':
    unittest.main()

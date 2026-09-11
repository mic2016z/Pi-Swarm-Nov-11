import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge

class DocumentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'LOCALAPPDATA': self.tmp.name})
        self.env.start()
        self.project = str(Path(self.tmp.name) / 'project')
        Path(self.project).mkdir()
    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()
    def test_roundtrip_isolation_and_conflict(self):
        text = '# Role\nUnicode: π 🎹 日本語\n' + 'long content ' * 4000
        bridge.document_write(self.project, 'oc-1', 'agent.md', text, '')
        self.assertEqual(bridge.document_read(self.project, 'oc-1', 'agent.md')['content'], text)
        self.assertIn('oc-2', bridge.document_read(self.project, 'oc-2', 'agent.md')['content'])
        other = str(Path(self.tmp.name) / 'other'); Path(other).mkdir()
        self.assertNotEqual(bridge.document_read(other, 'oc-1', 'agent.md')['content'], text)
        with self.assertRaisesRegex(ValueError, 'changed'):
            bridge.document_write(self.project, 'oc-1', 'agent.md', 'stale', '')
        self.assertEqual(bridge.document_read(self.project, 'oc-1', 'agent.md')['content'], text)
    def test_validation(self):
        for terminal, name in [('oc-999','agent.md'), ('../pi-1','agent.md'), ('oc-1','../agent.md'), ('auth','agent.md')]:
            with self.assertRaises(ValueError): bridge.document_read(self.project, terminal, name)
        with self.assertRaisesRegex(ValueError, '128 KB'):
            bridge.document_write(self.project, 'oc-1', 'context.md', 'x' * (128 * 1024 + 1), '')
    def test_junction_escape(self):
        bridge.config(self.project)
        # Documents live under <project>/.squad now, so that is where a junction
        # would be planted to redirect a write outside the project.
        folder = Path(self.project) / bridge.SQUAD_DIR
        folder.mkdir(parents=True, exist_ok=True)
        outside = Path(self.tmp.name) / 'outside'; outside.mkdir()
        junction = folder / 'oc-1'
        result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(junction), str(outside)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        try:
            with self.assertRaises(ValueError): bridge.document_write(self.project, 'oc-1', 'agent.md', 'escape', '')
            self.assertFalse((outside / 'agent.md').exists())
        finally:
            os.rmdir(junction)
    def test_latest_context_snapshot_and_task_last(self):
        self.assertIn('master', bridge.prompt_with_documents(self.project, 1, 'TASK'))
        for name in bridge.DOCUMENT_NAMES:
            bridge.document_write(self.project, 'oc-1', name, name + ' version one', bridge.document_read(self.project, 'oc-1', name)['content'])
        first = bridge.prompt_with_documents(self.project, 1, 'TASK')
        bridge.document_write(self.project, 'oc-1', 'context.md', 'version two', 'context.md version one')
        second = bridge.prompt_with_documents(self.project, 1, 'TASK')
        self.assertIn('version one', first)
        self.assertNotIn('version two', first)
        self.assertIn('version two', second)
        self.assertTrue(second.endswith('### Current task\nTASK'))
        self.assertNotIn('version two', bridge.prompt_with_documents(self.project, 2, 'TASK'))
    def test_default_panes_and_legacy_todo_preserved(self):
        self.assertEqual(list(bridge.config(self.project)['sessions']), [str(i) for i in range(1, bridge.DEFAULT_PANES + 1)])
        target = bridge.document_path(self.project, 'oc-1', 'todo.md')
        target.parent.mkdir(parents=True)
        legacy = target.with_name('todol.md')
        legacy.write_text('User legacy tasks π', encoding='utf-8')
        self.assertEqual(bridge.document_read(self.project, 'oc-1', 'todo.md')['content'], 'User legacy tasks π')
        bridge.document_write(self.project, 'oc-1', 'todo.md', 'Updated tasks', 'User legacy tasks π')
        self.assertEqual(bridge.document_read(self.project, 'oc-1', 'todol.md')['content'], 'Updated tasks')
        self.assertEqual(legacy.read_text(encoding='utf-8'), 'User legacy tasks π')
        bridge.add_agent(self.project)
        bridge.ensure_documents(self.project)
        self.assertIn(str(bridge.DEFAULT_PANES + 1), bridge.config(self.project)['sessions'])
        self.assertEqual(target.read_text(encoding='utf-8'), 'Updated tasks')
        for terminal in ['master', *('oc-' + str(i) for i in range(1, bridge.DEFAULT_PANES + 2))]:
            for name in bridge.DOCUMENT_NAMES:
                self.assertTrue(bridge.document_path(self.project, terminal, name).is_file())

    def test_existing_custom_instructions_preserved_with_current_capacity(self):
        bridge.document_write(self.project, 'master', 'agent.md', 'Custom role unchanged', '')
        bridge.initialize_project(self.project)
        self.assertEqual(bridge.document_read(self.project, 'master', 'agent.md')['content'], 'Custom role unchanged')
        context = bridge.document_context(self.project, 'master')
        self.assertIn(f'{bridge.DEFAULT_PANES} OpenCode workers', context)
        self.assertIn('without model calls', context)
        self.assertIn('provider rate limits', bridge.default_document(self.project, 'master', 'agent.md'))

    def test_cli_large_unicode_stdin(self):
        content = '🎹\n' * 9000
        argv = [sys.executable, str(Path(bridge.__file__)), 'document-write', '--project', self.project, '--terminal', 'master', '--filename', 'context.md']
        result = subprocess.run(argv, input=json.dumps({'content':content,'expected':''}), text=True, encoding='utf-8', capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['content'], content)

if __name__ == '__main__': unittest.main()

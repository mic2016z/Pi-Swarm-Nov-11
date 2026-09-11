"""Harness layer for OpenCode panes.

OpenCode stores sessions in its own database keyed by id, so Pi's session-file
ownership and mid-run switching no longer exist. What remains testable is the
launch contract: the model is always asserted explicitly, a recorded session is
resumed, and the squad plugin is published where OpenCode will auto-load it.
"""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import bridge


class HarnessLayerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'LOCALAPPDATA': self.temp.name})
        self.env.start()
        self.project = str(Path(self.temp.name) / 'project')
        Path(self.project).mkdir(parents=True, exist_ok=True)
        bridge.config(self.project)

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_model_is_always_asserted_explicitly(self):
        # A pane must never inherit the user's global OpenCode default.
        # Panes run unattended, so --auto travels with the model on every launch.
        self.assertEqual(bridge.model_args(self.project), ['--model', bridge.DEFAULT_MODEL, '--auto'])

    def test_flag_like_and_malformed_models_are_refused(self):
        for value in ['--dangerous', '', 'noslash', None, {'provider': 'x', 'model': 'y'}]:
            with self.assertRaises(ValueError):
                bridge.validated_model(value)

    def test_session_is_resumed_only_once_the_plugin_records_one(self):
        self.assertEqual(bridge.session_args(self.project, 1), [])
        bridge.atomic(bridge.state_for(self.project) / 'oc-1' / 'session.json',
                      {'agent': 'oc-1', 'sessionID': 'ses_abc123'})
        self.assertEqual(bridge.session_args(self.project, 1), ['--session', 'ses_abc123'])

    def test_recorded_session_that_looks_like_a_flag_is_ignored(self):
        bridge.atomic(bridge.state_for(self.project) / 'oc-2' / 'session.json', {'sessionID': '--inject'})
        self.assertEqual(bridge.session_args(self.project, 2), [])

    def test_plugin_is_published_where_opencode_auto_loads_it(self):
        target = bridge.deploy_plugin(self.project)
        self.assertEqual(target, Path(self.project) / '.opencode' / 'plugin' / 'squad.ts')
        self.assertIn('squad_claims', target.read_text(encoding='utf-8'))
        # Re-deploying refreshes a stale copy rather than leaving it behind.
        target.write_text('stale', encoding='utf-8')
        bridge.deploy_plugin(self.project)
        self.assertIn('squad_claims', target.read_text(encoding='utf-8'))

    def test_squad_env_identifies_the_pane(self):
        env = bridge.squad_env(self.project, 3)
        self.assertEqual(env['SQUAD_AGENT'], '3')
        self.assertEqual(Path(env['SQUAD_PROJECT']), Path(self.project).resolve())
        self.assertTrue(env['SQUAD_ROOT'].endswith('oc-3'))
        self.assertTrue(bridge.squad_env(self.project, 'master')['SQUAD_ROOT'].endswith('oc-master'))


if __name__ == '__main__':
    unittest.main()

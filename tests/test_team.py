import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

import bridge
import team


class TeamTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'LOCALAPPDATA': self.temp.name})
        self.env.start()
        self.project = str(Path(self.temp.name) / 'project')
        Path(self.project).mkdir()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_compact_cli_receipt_preserves_address_and_message(self):
        import sys
        result = subprocess.run([sys.executable, '-X', 'utf8', str(Path(team.__file__)),
            'send', '--project', self.project, '--sender', 'master', '--to', 'oc-2',
            '--text', 'DECISION: use the parser. NEXT: add the check. CHECK: tests pass.', '--compact'],
            capture_output=True, text=True, encoding='utf-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('@master -> @oc-2 [queued;', result.stdout)
        self.assertIn('NEXT: add the check.', result.stdout)
        self.assertNotIn('digest', result.stdout)

    def test_peer_message_routes_once(self):
        ident = str(uuid.uuid4())
        result = team.send(self.project, '@pi1', '@pi2', 'Found parser error', ident)
        self.assertEqual(result['status'], 'queued')
        self.assertEqual(team.send(self.project, 'oc-1', 'oc-2', 'Found parser error', ident), result)
        jobs = list((bridge.agent_dir(self.project, 2) / 'pending').glob('*.json'))
        self.assertEqual(len(jobs), 1)
        self.assertIn('@oc-1 → @oc-2', bridge.read(jobs[0])['prompt'])
        with self.assertRaises(ValueError):
            team.send(self.project, 'oc-1', 'oc-2', 'different', ident)

    def test_unbound_escalation_retained_and_flushes(self):
        result = team.send(self.project, 'oc-1', 'master', 'Need reasoning help')
        self.assertEqual(result['status'], 'undelivered')
        instance = str(uuid.uuid4())
        bridge.atomic(bridge.state_for(self.project) / 'master-runtime.json', {'instance': instance})
        sent = team.send(self.project, 'oc-1', 'master', result['text'], result['id'], retry_unbound=True)
        self.assertEqual(sent['status'], 'queued')
        self.assertEqual(sent['instance'], instance)
        inbox = bridge.state_for(self.project) / 'messenger' / 'inbox' / 'master'
        delivered = [json.loads(p.read_text(encoding='utf-8')) for p in inbox.glob('*.json')]
        self.assertEqual(len(delivered), 1)
        self.assertEqual(delivered[0]['to'], 'master')
        self.assertIn('Need reasoning help', delivered[0]['text'])
        self.assertEqual(list(inbox.glob('*.tmp')), [])

    def test_uncertain_not_replayed(self):
        bridge.atomic(bridge.state_for(self.project) / 'master-runtime.json', {'instance': str(uuid.uuid4())})
        with patch.object(team, 'deliver_to_master', side_effect=OSError('inbox write failed')):
            result = team.send(self.project, 'oc-1', 'master', 'help')
        self.assertEqual(result['status'], 'uncertain')
        self.assertEqual(team.flush(self.project), [])

    def test_claim_conflict_and_owner_release(self):
        team.claim(self.project, 'oc-1', ['src'], 'parser')
        with self.assertRaises(ValueError):
            team.claim(self.project, 'oc-2', ['src/main.py'])
        team.release(self.project, 'oc-2')
        self.assertEqual(len(team.claims(self.project)), 1)
        team.release(self.project, 'oc-1')
        team.claim(self.project, 'oc-2', ['src/main.py'])
        with self.assertRaises(ValueError):
            team.claim(self.project, 'oc-1', ['../outside'])

    def test_concurrent_claims_one_winner(self):
        def attempt(agent):
            try:
                team.claim(self.project, agent, ['shared.py'])
                return True
            except ValueError:
                return False
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(attempt, ['oc-1', 'oc-2']))
        self.assertEqual(sum(results), 1)

    def test_save_notifications_isolate_failures(self):
        with patch.object(team, 'send', side_effect=OSError('disk failure')):
            result = team.document_updated(self.project, 'oc-1', 'context.md', 'path')
        self.assertEqual({r['recipient'] for r in result}, {'oc-1', 'master'})
        self.assertTrue(all(v['status'] == 'failed' for v in result))

    def test_overview_reports_state_and_recorded_session(self):
        folder = bridge.state_for(self.project) / 'oc-1'
        folder.mkdir(parents=True, exist_ok=True)
        bridge.atomic(folder / 'session.json', {'agent': 'oc-1', 'sessionID': 'ses_recorded'})
        bridge.atomic(folder / 'worker.json', {'status': 'busy'})
        bridge.enqueue(self.project, 1, 'Do this task')
        team.claim(self.project, 'oc-1', ['src'])
        bridge.atomic(folder / 'results/000000000001.json',
                      {'id': '1', 'status': 'success', 'output': 'x' * 2000})
        result = team.overview(self.project)
        worker = next(a for a in result['agents'] if a['id'] == 'oc-1')
        self.assertEqual(worker['status'], 'stopped')
        self.assertEqual(worker['task'], 'Do this task')
        self.assertEqual(worker['session'], 'ses_recorded')
        self.assertEqual(len(worker['result']['summary']), 1500)
        self.assertEqual(len(worker['files']), 1)
        self.assertIsNone(result['agents'][0]['usage'])

    def test_metadata_reports_unavailable_rather_than_zero(self):
        # OpenCode keeps usage in its own database; absent data must never read as 0.
        for record in [{}, {'sessionID': ''}, {'sessionID': None}, None]:
            value = team._session_metadata(record)
            self.assertIsNone(value['usage'])
            self.assertIsNone(value['model'])
            self.assertIsNone(value['session'])
        self.assertEqual(team._session_metadata({'sessionID': 'ses_x'})['session'], 'ses_x')


if __name__ == '__main__':
    unittest.main()

"""Keyless checks for retained failures and honest evaluation denominators."""
import json
import os
import signal
import subprocess
import time
from pathlib import Path
import sys
import tempfile
import unittest
from run import execute, digest, process_group_running
from summarize import aggregate, observations


class EvaluationTests(unittest.TestCase):
    def test_missing_audits_and_unstarted_slots_are_not_passes(self):
        rows = [
            {'name': 'plan-baseline-1', 'nonemptyFinal': True, 'timedOut': False},
            {'name': 'plan-baseline-2', 'nonemptyFinal': False, 'timedOut': True},
            {'name': 'plan-baseline-3', 'unstarted': True},
        ]
        self.assertEqual(aggregate(rows)['baseline'], dict(planned=3, attempted=2, completed=1,
                         timedOut=1, audited=0, unreviewed=1, perfect=0, E=0, L=0, M=0, I=0))

    def test_interrupted_record_is_not_an_unstarted_slot(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            (source / 'manifest.json').write_text(json.dumps({'runs': ['plan-baseline-1']}))
            slot = source / 'plan-baseline-1'
            slot.mkdir()
            (slot / 'stdout.jsonl').write_text('{}\n')
            with self.assertRaisesRegex(ValueError, 'incomplete execution record'):
                observations(source)

    def test_bad_denominators_and_duplicate_attempts_fail(self):
        row = {'name': 'plan-a-colon-1', 'nonemptyFinal': True, 'timedOut': False,
               'counts': {'E': 2, 'L': 1, 'M': 0, 'I': 0}}
        with self.assertRaisesRegex(ValueError, 'E must equal'):
            aggregate([row])
        row['counts']['M'] = 1
        self.assertEqual(aggregate([row])['a-colon']['M'], 1)
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            aggregate([row, row])
        row['counts']['E'] = True
        with self.assertRaisesRegex(ValueError, 'nonnegative integers'):
            aggregate([row])

    def test_frozen_inputs_match_original_hashes(self):
        owner = Path(__file__).parent
        hashes = json.loads((owner / 'results/2026-09-16/observations.json').read_text())['inputHashes']
        for kind, expected in hashes.items():
            folder = 'cases' if kind == 'tasks' else 'prompts'
            for name, value in expected.items():
                self.assertEqual(digest(owner / folder / (name + '.txt')), value)

    def test_zombie_group_has_no_running_work(self):
        child = subprocess.Popen([sys.executable, '-c',
            'import time; print("ready", flush=True); time.sleep(60)'],
            stdout=subprocess.PIPE, text=True, start_new_session=True)
        try:
            self.assertEqual(child.stdout.readline(), 'ready\n')
            self.assertTrue(process_group_running(child.pid))
            child.kill()
            deadline = time.monotonic() + 5
            while not subprocess.check_output(['ps', '-p', str(child.pid), '-o', 'stat='], text=True).strip().startswith('Z'):
                if time.monotonic() >= deadline:
                    self.fail('Killed child did not reach zombie state')
                time.sleep(.01)
            # Deliberately leave our child unreaped while checking the same group.
            if sys.platform == 'linux':
                os.killpg(child.pid, 0)
            self.assertFalse(process_group_running(child.pid))
        finally:
            child.kill()
            child.communicate()

    def test_successful_leader_does_not_leave_a_term_ignoring_descendant_running(self):
        with tempfile.TemporaryDirectory() as root:
            slot = Path(root)
            task = slot / 'task.txt'
            task.write_text('task')
            descendant = 'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print("ready",flush=True); time.sleep(60)'
            code = f"""import json, subprocess, sys
child = subprocess.Popen([sys.executable, '-c', {descendant!r}], stdout=subprocess.PIPE, text=True)
assert child.stdout.readline() == 'ready\\n'
print(json.dumps({{'pid': child.pid}}), flush=True)
print(json.dumps({{'type': 'final', 'text': 'done'}}), flush=True)
"""
            result = execute([sys.executable, '-c', code], slot, task, slot, 10)
            pid = json.loads((slot / 'stdout.jsonl').read_text().splitlines()[0])['pid']
            try:
                self.assertFalse(result['timedOut'])
                self.assertEqual(result['exitCode'], 0)
                self.assertTrue(result['nonemptyFinal'])
                self.assertIsNone(result['teardownError'])
                state = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True, check=False)
                self.assertTrue(state.returncode == 1 or state.stdout.strip().startswith('Z'))
            finally:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_historical_counts_reproduce_report(self):
        source = Path(__file__).parent / 'results/2026-09-16/observations.json'
        groups = aggregate(observations(source))
        for variant, expected in [('baseline', (476, 453, 23, 0)),
                                  ('filename', (585, 539, 45, 1)), ('display', (592, 467, 124, 1))]:
            self.assertEqual(tuple(groups[variant][k] for k in ['E', 'L', 'M', 'I']), expected)
        self.assertEqual(groups['baseline']['timedOut'], 1)

    def test_annotation_cannot_reclassify_changed_first_answer(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root)
            (source / 'manifest.json').write_text(json.dumps({'runs': ['plan-baseline-1']}))
            slot = source / 'plan-baseline-1'
            slot.mkdir()
            final = slot / 'final.md'
            final.write_text('first answer')
            original = digest(final)
            (slot / 'execution.json').write_text(json.dumps({'nonemptyFinal': True, 'timedOut': False, 'finalSha256': original}))
            (slot / 'annotation.json').write_text(json.dumps({'finalSha256': original, 'counts': {'E': 1, 'L': 1, 'M': 0, 'I': 0}}))
            self.assertEqual(aggregate(observations(source))['baseline']['L'], 1)
            final.write_text('changed answer')
            with self.assertRaisesRegex(ValueError, 'does not match'):
                observations(source)

    def test_malformed_output_retains_execution_failure(self):
        with tempfile.TemporaryDirectory() as root:
            slot = Path(root)
            task = slot / 'task.txt'
            task.write_text('task')
            result = execute([sys.executable, '-c', 'print("not json")'], slot, task, slot, 10)
            self.assertIsNotNone(result['outputError'])
            self.assertTrue((slot / 'execution.json').exists())

    def test_timeout_preserves_output_and_reaps_process(self):
        with tempfile.TemporaryDirectory() as root:
            slot = Path(root)
            task = slot / 'task.txt'
            task.write_text('task')
            result = execute([sys.executable, '-c', 'import time; print("{}", flush=True); time.sleep(60)'],
                             slot, task, slot, .2)
            self.assertTrue(result['timedOut'])
            self.assertFalse(result['nonemptyFinal'])
            self.assertIsNotNone(result['exitCode'])
            self.assertEqual((slot / 'stdout.jsonl').read_text(), '{}\n')
            self.assertEqual(json.loads((slot / 'execution.json').read_text())['timedOut'], True)
            with self.assertRaises(FileExistsError):
                execute([sys.executable, '-c', 'pass'], slot, task, slot, 1)


if __name__ == '__main__':
    unittest.main()

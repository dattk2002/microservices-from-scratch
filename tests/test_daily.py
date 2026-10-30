import json
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

import automation.daily as daily
from automation.daily import next_lesson, validate_lesson_changes


class CourseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.lesson = {'id': '01-boundaries', 'title': 'Service boundaries', 'requirements': ['Real HTTP test']}
        (self.root / 'curriculum.json').write_text(json.dumps([self.lesson]))

    def complete_lesson(self):
        directory = self.root / 'lessons' / self.lesson['id']
        (directory / 'test').mkdir(parents=True, exist_ok=True)
        (directory / 'README.md').write_text('A complete Vietnamese guide\n')
        (directory / 'lesson.json').write_text(json.dumps({'id': self.lesson['id'], 'entrypoints': ['service.mts']}))
        (directory / 'service.mts').write_text('export {};\n')
        (directory / 'test/lesson.test.mts').write_text('export {};\n')
        return directory

    def paths(self):
        return [str(p.relative_to(self.root)) for p in (self.root / 'lessons').rglob('*') if p.is_file()]

    def init_git(self):
        def git(*args):
            return subprocess.run(['git', *args], cwd=self.root, check=True, capture_output=True, text=True).stdout.strip()
        git('init', '-q')
        git('config', 'user.name', 'Test')
        git('config', 'user.email', 'test@example.invalid')
        git('add', '.')
        git('commit', '-qm', 'Initial fixture')
        return git

    def test_next_unfinished_and_exhausted_curriculum(self):
        self.assertEqual(next_lesson(self.root), self.lesson)
        self.complete_lesson()
        self.assertIsNone(next_lesson(self.root))

    def test_partial_lesson_is_not_overwritten(self):
        folder = self.root / 'lessons' / self.lesson['id']
        folder.mkdir(parents=True)
        (folder / 'README.md').write_text('User work\n')
        with self.assertRaises(ValueError): next_lesson(self.root)

    def test_validates_entire_curriculum_before_selecting(self):
        for entries in [[self.lesson, self.lesson], [self.lesson, {'id': '../../elsewhere', 'title': 'bad', 'requirements': []}]]:
            (self.root / 'curriculum.json').write_text(json.dumps(entries))
            with self.assertRaises(ValueError): next_lesson(self.root)

    def test_partial_later_lesson_blocks_even_when_first_is_missing(self):
        later = dict(self.lesson, id='02-later')
        (self.root / 'curriculum.json').write_text(json.dumps([self.lesson, later]))
        (self.root / 'lessons' / later['id']).mkdir(parents=True)
        with self.assertRaises(ValueError): next_lesson(self.root)

    def test_command_caps_both_capture_and_log_while_running(self):
        script = "import os; os.write(1, b'x' * 100000)"
        with patch.object(daily, 'MAX_OUTPUT', 4096, create=True):
            for use_log in [False, True]:
                with self.subTest(log=use_log), tempfile.TemporaryFile(mode='w+') as log:
                    with self.assertRaisesRegex(RuntimeError, 'output.*limit'):
                        daily.command([sys.executable, '-c', script], log=log if use_log else None)
                    self.assertLessEqual(log.tell(), 4096)

    @unittest.skipUnless(shutil.which('codex') and shutil.which('bwrap'), 'Codex permission integration prerequisite')
    def test_worker_policy_denies_other_reads_and_infrastructure_writes(self):
        folder = self.complete_lesson()
        (self.root / 'trusted.py').write_text('VALUE = "trusted"\n')
        with tempfile.TemporaryDirectory(prefix='outside-policy-') as outside:
            harmless = Path(outside) / 'non-secret.txt'
            harmless.write_text('test fixture only')
            script = f"""
import os
from pathlib import Path
root=Path({str(self.root)!r})
assert (root/'trusted.py').read_text() == 'VALUE = "trusted"\\n'
try:
    Path({str(harmless)!r}).read_text()
except (PermissionError, FileNotFoundError):
    pass
else:
    raise AssertionError('default-deny read failed')
for target in [root/'trusted.py', root/'__pycache__'/'trusted.pyc']:
    try:
        target.parent.mkdir(exist_ok=True)
        target.write_text('untrusted')
    except (PermissionError, OSError):
        pass
    else:
        raise AssertionError('infrastructure or cache write escaped')
Path({str(folder / 'allowed.mts')!r}).write_text('export {{}};')
print('PERMISSIONS_OK')
"""
            args = ['codex', 'sandbox', '-P', 'micro_lesson', '-C', str(self.root),
                    *daily.codex_permission_args(self.root, folder), '--', sys.executable, '-B', '-c', script]
            output = daily.command(daily.pid_namespace_args(args, root=self.root, writable=folder), timeout=15)
            self.assertIn('PERMISSIONS_OK', output)
            self.assertTrue((folder / 'allowed.mts').exists())
            self.assertEqual((self.root / 'trusted.py').read_text(), 'VALUE = "trusted"\n')
            self.assertFalse((self.root / '__pycache__').exists())

    def test_accepts_one_complete_new_lesson(self):
        self.complete_lesson()
        validate_lesson_changes(self.root, self.lesson['id'], self.paths())

    def test_rejects_infrastructure_and_other_lesson_changes(self):
        self.complete_lesson()
        for path in ['.github/workflows/test.yml', 'package.json', 'automation/daily.py',
                     'lessons/02-other/README.md', 'lessons/01-boundaries/escape.py']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                validate_lesson_changes(self.root, self.lesson['id'], [path])

    def test_rejects_missing_empty_or_oversized_files(self):
        folder = self.complete_lesson()
        for value in ['', 'x' * 100001]:
            (folder / 'service.mts').write_text(value)
            with self.assertRaises(ValueError): validate_lesson_changes(self.root, self.lesson['id'], self.paths())
        (folder / 'service.mts').unlink()
        with self.assertRaises(ValueError): validate_lesson_changes(self.root, self.lesson['id'], self.paths())

    def test_manifest_cannot_escape_or_name_missing_entries(self):
        folder = self.complete_lesson()
        for entries in [[], ['../outside.mts'], ['/tmp/outside.mts'], ['missing.mts'], ['service.mts', 'service.mts']]:
            (folder / 'lesson.json').write_text(json.dumps({'id': self.lesson['id'], 'entrypoints': entries}))
            with self.assertRaises(ValueError): validate_lesson_changes(self.root, self.lesson['id'], self.paths())
        (folder / 'lesson.json').write_text(json.dumps({'id': '02-wrong', 'entrypoints': ['service.mts']}))
        with self.assertRaises(ValueError): validate_lesson_changes(self.root, self.lesson['id'], self.paths())

    def test_manifest_must_be_an_object(self):
        folder = self.complete_lesson()
        for value in [None, [], 'invalid']:
            (folder / 'lesson.json').write_text(json.dumps(value))
            with self.assertRaises(ValueError): validate_lesson_changes(self.root, self.lesson['id'], self.paths())

    def test_symlink_files_and_parent_directories_are_rejected(self):
        folder = self.complete_lesson()
        outside = self.root / 'outside.mts'
        outside.write_text('private bytes')
        (folder / 'service.mts').unlink()
        (folder / 'service.mts').symlink_to(outside)
        with self.assertRaises(ValueError): validate_lesson_changes(self.root, self.lesson['id'], self.paths())
        (folder / 'service.mts').unlink()
        (folder / 'service.mts').write_text('export {};\n')
        (folder / 'alias').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            validate_lesson_changes(self.root, self.lesson['id'], ['lessons/01-boundaries/alias/outside.mts'])

    def test_hardlinked_deliverable_is_rejected(self):
        folder = self.complete_lesson()
        target = self.root / 'outside.mts'
        target.write_text('private bytes')
        (folder / 'service.mts').unlink()
        os.link(target, folder / 'service.mts')
        with self.assertRaises(ValueError): validate_lesson_changes(self.root, self.lesson['id'], self.paths())

    def test_file_count_and_total_size_are_bounded(self):
        folder = self.complete_lesson()
        for i in range(17): (folder / f'extra{i}.mts').write_text('export {};\n')
        with self.assertRaises(ValueError): validate_lesson_changes(self.root, self.lesson['id'], self.paths())
        for i in range(17): (folder / f'extra{i}.mts').unlink()
        for i in range(3): (folder / f'large{i}.mts').write_text('x' * 90000)
        with self.assertRaises(ValueError): validate_lesson_changes(self.root, self.lesson['id'], self.paths())

    def test_durable_state_roundtrip_has_no_temp_file(self):
        path = self.root / 'state.json'
        daily.write_state(path, {'phase': 'publishing', 'head': 'abc'})
        self.assertEqual(json.loads(path.read_text()), {'phase': 'publishing', 'head': 'abc'})
        self.assertFalse(path.with_suffix('.tmp').exists())

    def test_isolated_runner_refuses_root_identity(self):
        with patch.object(daily.os, 'geteuid', return_value=0), self.assertRaises(ValueError):
            daily.container_args(self.root, 'test', 'token')

    @unittest.skipUnless(shutil.which('docker'), 'Docker integration prerequisite')
    def test_isolated_container_has_only_private_loopback_and_readonly_source(self):
        self.root.chmod(0o755)
        (self.root / 'package.json').write_text(json.dumps({'scripts': {'check': 'node probe.mjs'}}))
        (self.root / 'probe.mjs').write_text('''
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
assert.notEqual(process.getuid(), 0);
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.HOME, '/tmp');
assert.equal(fs.existsSync('/var/run/docker.sock'), false);
assert.throws(() => fs.writeFileSync('/workspace/forbidden', 'bad'));
await assert.rejects(fetch('http://1.1.1.1', {signal:AbortSignal.timeout(300)}));
const server=createServer((_req,res)=>res.end('ok'));
server.listen(0,'127.0.0.1'); await once(server,'listening');
assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(),'ok');
server.close(); server.closeAllConnections();
console.log('ISOLATION_OK');
''')
        output = daily.run_isolated_tests(self.root, timeout=30)
        self.assertIn('ISOLATION_OK', output)
        self.assertFalse((self.root / 'forbidden').exists())

    @unittest.skipUnless(shutil.which('docker'), 'Docker integration prerequisite')
    def test_timed_out_docker_check_cleans_its_owned_container(self):
        self.root.chmod(0o755)
        (self.root / 'package.json').write_text(json.dumps({'scripts': {'check': 'node hang.mjs'}}))
        (self.root / 'hang.mjs').write_text('setInterval(()=>{},1000);\n')
        run_id = daily.uuid.uuid4()
        with patch.object(daily.uuid, 'uuid4', return_value=run_id), self.assertRaisesRegex(RuntimeError, 'timed out'):
            daily.run_isolated_tests(self.root, timeout=2)
        args = ['docker', 'ps', '-a', '--filter', f'name=^/microservices-test-{run_id.hex}$', '--format', '{{.ID}}']
        self.assertEqual(daily.command(args), '')


    def test_changed_paths_include_untracked_files_and_tracked_edits(self):

        def git(*args):
            return subprocess.run(['git', *args], cwd=self.root, check=True, capture_output=True, text=True)
        git('init', '-q')
        (self.root / 'tracked.txt').write_text('before\n')
        git('add', '.')
        git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Initial fixture')
        (self.root / 'tracked.txt').write_text('after\n')
        (self.root / 'new.txt').write_text('new\n')
        self.assertEqual(set(daily.changed_paths(self.root)), {'tracked.txt', 'new.txt'})

    def test_child_commands_do_not_inherit_stdin(self):
        source = "from automation.daily import command; import sys; print(command([sys.executable, '-c', 'import sys; print(repr(sys.stdin.read()))']))"
        result = subprocess.run([sys.executable, '-c', source], cwd=Path(__file__).resolve().parents[1], input='unexpected inherited input', text=True, capture_output=True, check=True, timeout=5)
        self.assertEqual(result.stdout.strip(), "''")

    def test_stops_before_auth_or_writes_after_an_uncertain_run(self):
        (self.root / 'state.json').write_text(json.dumps({'phase': 'publishing'}))
        with patch.object(daily, 'command', side_effect=AssertionError('must not run')):
            daily.run_daily(self.root)

    def test_stops_before_auth_or_writes_after_same_day_success(self):
        today = datetime.now(ZoneInfo('Asia/Ho_Chi_Minh')).date().isoformat()
        (self.root / 'state.json').write_text(json.dumps({'phase': 'merged', 'date': today}))
        with patch.object(daily, 'command', side_effect=AssertionError('must not run')):
            daily.run_daily(self.root)

    def test_rejects_a_clean_checkout_ahead_of_the_pinned_base(self):
        git = self.init_git()
        base = git('rev-parse', 'HEAD')
        (self.root / 'unreviewed.txt').write_text('unreviewed work\n')
        git('add', '.')
        git('commit', '-qm', 'Local-only commit')
        with self.assertRaisesRegex(ValueError, 'base'):
            daily.validate_base(self.root, base)

    def test_rejects_a_different_effective_push_url(self):
        git = self.init_git()
        git('remote', 'add', 'origin', daily.REMOTE)
        git('config', 'remote.origin.pushurl', str(self.root / 'other-repo'))
        with self.assertRaisesRegex(ValueError, 'origin'):
            daily.validate_remote(self.root)

    def test_completed_commands_cannot_leave_background_writers(self):
        marker = self.root / 'late-write.txt'
        child = f"import time; from pathlib import Path; time.sleep(0.3); Path({str(marker)!r}).write_text('late')"
        parent = f"import subprocess,sys; subprocess.Popen([sys.executable,'-c',{child!r}],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)"
        daily.command([sys.executable, '-c', parent], timeout=2)
        time.sleep(0.5)
        self.assertFalse(marker.exists(), 'A child survived its completed command')

    def test_validates_real_nul_terminated_committed_diff(self):
        git = self.init_git()
        base = git('rev-parse', 'HEAD')
        self.complete_lesson()
        git('add', '.')
        git('commit', '-qm', 'Complete lesson')
        paths = daily.committed_paths(self.root, base, 'HEAD')
        self.assertEqual(len(paths), 4)
        validate_lesson_changes(self.root, self.lesson['id'], paths)

    @unittest.skipUnless(shutil.which('bwrap'), 'Linux bubblewrap integration')
    def test_worker_namespace_removes_even_detached_children(self):
        marker = self.root / 'detached-write.txt'
        child = f"import time; from pathlib import Path; time.sleep(0.3); Path({str(marker)!r}).write_text('late')"
        parent = f"import subprocess,sys; subprocess.Popen([sys.executable,'-c',{child!r}],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)"
        daily.command(daily.pid_namespace_args([sys.executable, '-c', parent]), timeout=5)
        time.sleep(0.5)
        self.assertFalse(marker.exists(), 'Detached child escaped worker lifetime')

if __name__ == '__main__':
    unittest.main()

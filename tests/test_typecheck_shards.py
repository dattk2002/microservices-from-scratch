"""Exercise the package typecheck entry point on a complete, multi-shard program."""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TSC = ROOT / 'node_modules/typescript/bin/tsc'


def typecheck(directory, *, env=None):
    command = shlex.split(json.loads((ROOT / 'package.json').read_text())['scripts']['typecheck'])
    args = [str(ROOT / arg) if (ROOT / arg).is_file() else arg for arg in command]
    return subprocess.run(args, cwd=directory, env=env, capture_output=True, text=True, timeout=45)


def diagnostics(result):
    return sorted(re.findall(r'([^\s(]+)\(\d+,\d+\): error (TS\d+)', result.stdout + result.stderr))


class TypecheckShardTests(unittest.TestCase):
    def test_full_program_is_checked_in_sequential_bounded_workers(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            filler = [f'f{n:03}.mts' for n in range(201)]
            for name in filler:
                (project / name).write_text('export {};')
            (project / 'consumer.mts').write_text(
                "import './transitive.mts';\nexport const value: SharedType = 'hello';")
            (project / 'ambient.d.mts').write_text("declare global { type SharedType = string; } export {};")
            (project / 'transitive.mts').write_text("export const broken: number = 'wrong';")
            (project / 'last.mts').write_text("export const last: boolean = 42;")
            (project / 'bad.d.mts').write_text('export declare const broken: Missing;')
            config = {'compilerOptions': {'target': 'es5', 'module': 'nodenext', 'types': [],
                                          'strict': True, 'skipLibCheck': False},
                      'files': ['consumer.mts', 'bad.d.mts', *filler, 'last.mts', 'ambient.d.mts']}
            (project / 'tsconfig.json').write_text(json.dumps(config))
            reference = subprocess.run(['node', TSC, '--noEmit', '--pretty', 'false'], cwd=project,
                                       capture_output=True, text=True, timeout=30)
            self.assertEqual(diagnostics(reference), [('bad.d.mts', 'TS2304'), ('last.mts', 'TS2322'),
                                                       ('transitive.mts', 'TS2322')])
            broken = typecheck(project)
            self.assertNotEqual(broken.returncode, 0)
            self.assertEqual(diagnostics(broken), diagnostics(reference))

            (project / 'bad.d.mts').write_text('export declare const fixed: string;')
            (project / 'transitive.mts').write_text('export const fixed: number = 1;')
            (project / 'last.mts').write_text('export const last: boolean = true;')
            # Record process lifetimes via a Node preload without changing the checked sources.
            probe = project / 'probe.cjs'
            probe.write_text("""
const {appendFileSync} = require('node:fs');
function record(event) {
  appendFileSync('processes.jsonl', JSON.stringify([event, process.pid, process.ppid, process.execArgv]) + '\\n');
}
record('start');
process.on('exit', () => record('exit'));
""")
            files_before = set(project.iterdir())
            result = typecheck(project, env={**os.environ, 'NODE_OPTIONS': f'--require={probe}'})
            self.assertEqual(result.returncode, 0, result.stderr)
            log = project / 'processes.jsonl'
            self.assertEqual(set(project.iterdir()) - files_before, {log}, 'typecheck must not emit files')
            events = [json.loads(line) for line in log.read_text().splitlines()]
            coordinator = events[0][1]
            children = [event for event in events if event[2] == coordinator]
            self.assertGreaterEqual(len(children), 6, 'expected discovery and at least two checking workers')
            for start, end in zip(children[::2], children[1::2], strict=True):
                self.assertEqual((start[0], end[0], start[1]), ('start', 'exit', end[1]))
                self.assertIn('--max-old-space-size=320', start[3])

    def test_failed_worker_makes_the_package_command_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / 'entry.mts').write_text('export const ok = true;')
            (project / 'tsconfig.json').write_text(json.dumps(
                {'compilerOptions': {'types': []}, 'files': ['entry.mts']}))
            probe = project / 'fail-worker.cjs'
            probe.write_text("if (process.argv[2] === 'check') process.exit(13);")
            result = typecheck(project, env={**os.environ, 'NODE_OPTIONS': f'--require={probe}'})
            self.assertEqual(result.returncode, 13, result.stderr)

    def test_invalid_configuration_and_declaration_diagnostics_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            (project / 'entry.mts').write_text('export const value = Math.random();')
            config = project / 'tsconfig.json'
            config.write_text(json.dumps({'compilerOptions': {'typoOption': True}, 'files': ['entry.mts']}))
            result = typecheck(project)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('TS5023', result.stderr + result.stdout)
            config.write_text(json.dumps({'compilerOptions': {'declaration': True, 'isolatedDeclarations': True,
                                                               'types': []}, 'files': ['entry.mts']}))
            result = typecheck(project)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('TS9010', result.stderr + result.stdout)
            self.assertEqual(set(p.name for p in project.iterdir()), {'entry.mts', 'tsconfig.json'})

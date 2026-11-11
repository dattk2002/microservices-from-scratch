"""Compile the Node runtime boundary without executing any HTTP requests."""
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class TypeScriptRuntimeTests(unittest.TestCase):
    def test_node_fetch_types_exist_and_browser_globals_are_rejected(self):
        script = r"""
const ts = require('./node_modules/typescript');
const path = require('node:path');
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
if (parsed.errors.length) throw Error('Invalid compiler configuration');
const filename = path.join(process.cwd(), 'test', 'virtual-node-contract.mts');
const source = `const reply: Response = await fetch('http://example.invalid');
const payload: unknown = await reply.json();
document.title = 'Browser globals must be unavailable';
window.close();
export {};`;
const host = ts.createCompilerHost(parsed.options);
const original = host.getSourceFile.bind(host);
host.getSourceFile = (name, language, onError, fresh) => name === filename
  ? ts.createSourceFile(name, source, language, true)
  : original(name, language, onError, fresh);
const program = ts.createProgram([filename], parsed.options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
console.log(JSON.stringify(diagnostics.map(d => ({code:d.code, message:ts.flattenDiagnosticMessageText(d.messageText, '\n')}))));
"""
        result = subprocess.run(['node', '-e', script], cwd=ROOT, text=True,
                                capture_output=True, timeout=30, check=True)
        diagnostics = json.loads(result.stdout)
        self.assertEqual(sorted(d['code'] for d in diagnostics), [2304, 2584],
                         'Node fetch must compile while window/document are rejected: ' + repr(diagnostics))
        self.assertTrue(any('document' in d['message'] for d in diagnostics))
        self.assertTrue(any('window' in d['message'] for d in diagnostics))

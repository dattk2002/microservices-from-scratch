import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const chunkSize = 200;
const script = fileURLToPath(import.meta.url);

function runChild(mode, assignment) {
  const child = spawnSync(process.execPath, ['--max-old-space-size=320', script, mode], {
    input: assignment && JSON.stringify(assignment),
    encoding: 'utf8',
    stdio: ['pipe', mode === 'discover' ? 'pipe' : 'inherit', 'inherit'],
  });
  if (child.error) throw child.error;
  if (child.signal) throw new Error(`TypeScript worker terminated by ${child.signal}`);
  return child;
}

function coordinate() {
  const discovery = runChild('discover');
  if (discovery.status !== 0) return discovery.status;
  const files = JSON.parse(discovery.stdout);
  if (!Array.isArray(files) || !files.every(file => typeof file === 'string')) {
    throw new Error('Invalid TypeScript source manifest');
  }
  let status = 0;
  for (let start = 0; start < files.length; start += chunkSize) {
    const worker = runChild('check', { files, start });
    if (worker.status !== 0) status = worker.status;
  }
  return status;
}

async function compile(mode) {
  const { default: ts } = await import('typescript');
  const formatHost = {
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
    getCanonicalFileName: name => ts.sys.useCaseSensitiveFileNames ? name : name.toLowerCase(),
  };
  function report(diagnostics) {
    if (diagnostics.length) process.stderr.write(ts.formatDiagnostics(diagnostics, formatHost));
  }
  const config = ts.getParsedCommandLineOfConfigFile(resolve('tsconfig.json'), { noEmit: true }, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => report([diagnostic]),
  });
  if (!config) return 1;
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: config.options,
    projectReferences: config.projectReferences,
    configFileParsingDiagnostics: config.errors,
  });
  const sources = program.getSourceFiles();
  if (mode === 'discover') {
    const diagnostics = ts.sortAndDeduplicateDiagnostics([
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
    ]);
    report(diagnostics);
    if (diagnostics.length) return 1;
    process.stdout.write(JSON.stringify(sources.map(source => source.fileName)));
    return 0;
  }

  const { files, start } = JSON.parse(readFileSync(0, 'utf8'));
  if (!Array.isArray(files) || files.length !== sources.length ||
      !sources.every((source, index) => source.fileName === files[index])) {
    throw new Error('TypeScript source manifest changed between discovery and checking');
  }
  if (!Number.isSafeInteger(start) || start < 0 || start >= files.length || start % chunkSize !== 0) {
    throw new Error('Invalid TypeScript shard offset');
  }
  const diagnostics = [];
  for (const source of sources.slice(start, start + chunkSize)) {
    diagnostics.push(...program.getSemanticDiagnostics(source));
    if (config.options.declaration || config.options.composite) {
      diagnostics.push(...program.getDeclarationDiagnostics(source));
    }
  }
  report(ts.sortAndDeduplicateDiagnostics(diagnostics));
  return diagnostics.length ? 1 : 0;
}

const mode = process.argv[2];
if (mode === undefined) process.exitCode = coordinate();
else if (mode === 'discover' || mode === 'check') process.exitCode = await compile(mode);
else throw new Error(`Unknown TypeScript worker mode: ${mode}`);

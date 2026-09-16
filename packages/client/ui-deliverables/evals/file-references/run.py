"""Run preserved file-reference tasks through built dsh profiles on POSIX hosts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

OWNER = Path(__file__).resolve().parent
REPO = OWNER.parents[4]


def digest(path):
    """Hash exact input or output bytes without parsing their contents."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def execute(command, workspace, task, slot, timeout):
    """Preserve first output and reap the owned process group, including on interruption."""
    started = time.monotonic()
    timed_out = False
    interrupted = False
    with task.open('rb') as stdin, (slot / 'stdout.jsonl').open('xb') as stdout, (slot / 'stderr.txt').open('xb') as stderr:
        child = subprocess.Popen(command, cwd=workspace, stdin=stdin, stdout=stdout,
                                 stderr=stderr, start_new_session=True)
        try:
            child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        except KeyboardInterrupt:
            interrupted = True
        finally:
            # Terminate descendants that inherit the launcher process group.
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
    # A descendant may ignore TERM after the leader exits; never leave it running.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 5
    teardown_error = None
    while True:
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            break
        if time.monotonic() >= deadline:
            teardown_error = 'Owned process group did not finish teardown'
            break
        time.sleep(.01)
    finals = []
    output_error = None
    for line in (slot / 'stdout.jsonl').read_text().splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            output_error = 'stdout contains a non-JSON line; inspect preserved output'
            break
        if event.get('type') == 'final':
            finals.append(event['text'])
    final = finals[-1] if finals else ''
    if final.strip():
        (slot / 'final.md').write_text(final + '\n')
    result = {'exitCode': child.returncode, 'timedOut': timed_out,
              'interrupted': interrupted, 'outputError': output_error, 'teardownError': teardown_error, 'durationSeconds': time.monotonic() - started,
              'nonemptyFinal': bool(final.strip()),
              'finalSha256': digest(slot / 'final.md') if final.strip() else None}
    (slot / 'execution.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def main():
    """Freeze inputs before serial execution; stop at the first failed attempt."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--variant', nargs='+', choices=['baseline', 'filename', 'display', 'a-colon'], default=['baseline', 'filename', 'display'])
    parser.add_argument('--case', nargs='+', choices=['plan', 'diagnose', 'review', 'explain'], default=['plan', 'diagnose', 'review', 'explain'])
    parser.add_argument('--repetitions', type=int, default=3)
    parser.add_argument('--timeout', type=float, default=480)
    parser.add_argument('--model', required=True, help='Explicit DeepSeek model id, recorded with every run')
    parser.add_argument('--env-file', type=Path, help='Normal DSH .env source; values are never read by this runner')
    parser.add_argument('--output', type=Path, help='New directory under repository .artifacts/')
    parser.add_argument('--prepare-only', action='store_true', help='Freeze the cohort without calling the API')
    args = parser.parse_args()
    if os.name != 'posix':
        parser.error('Process-group cleanup requires a POSIX host')
    if args.repetitions < 1 or not 0 < args.timeout <= 480:
        parser.error('Use positive repetitions and a timeout no greater than 480 seconds')
    if len(set(args.variant)) != len(args.variant) or len(set(args.case)) != len(args.case):
        parser.error('Cases and variants must be unique')
    launcher = REPO / 'apps/cli/lib/bin.js'
    if not launcher.is_file():
        parser.error('Build this checkout with pnpm run build first')
    root = REPO / '.artifacts/file-reference-evals'
    root.mkdir(parents=True, exist_ok=True)
    output = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix='run-', dir=root))
    if args.output:
        if not output.is_relative_to(REPO / '.artifacts'):
            parser.error('--output must be inside repository .artifacts/')
        output.mkdir(mode=0o700)
    output.chmod(0o700)
    env_args = ['--env-file=' + str(args.env_file.resolve())] if args.env_file else []
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
    archive = output / 'source.tar'
    with archive.open('xb') as target:
        subprocess.run(['git', 'archive', 'HEAD'], cwd=REPO, stdout=target, check=True)
    frozen = output / 'inputs'
    frozen.mkdir()
    for folder in ['cases', 'prompts']:
        shutil.copytree(OWNER / folder, frozen / folder)
    shutil.copyfile(OWNER / 'treatment.mjs', frozen / 'treatment.mjs')
    shutil.copyfile(OWNER / 'rubric.md', frozen / 'rubric.md')
    names = [f'{case}-{variant}-{repeat}' for repeat in range(1, args.repetitions + 1)
             for case in args.case for variant in args.variant]
    manifest = {'sourceRevision': revision, 'launcherSha256': digest(launcher),
                'sourceArchiveSha256': digest(archive), 'runs': names,
                'model': args.model, 'reasoningEffort': 'high', 'timeoutSeconds': args.timeout,
                'preparedOnly': args.prepare_only, 'cohort': 'portable-owner-eval',
                'inputs': {str(p.relative_to(frozen)): digest(p) for p in frozen.rglob('*') if p.is_file()}}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(output, flush=True)
    if args.prepare_only:
        return
    for name in names:
        case, variant = name.rsplit('-', 1)[0].split('-', 1)
        slot = output / name
        slot.mkdir()
        workspace = slot / 'workspace'
        workspace.mkdir()
        subprocess.run(['tar', '-xf', str(archive), '-C', str(workspace)], check=True)
        # Evaluator instructions and historical scores are not task inputs.
        evals = workspace / OWNER.relative_to(REPO)
        if evals.exists():
            shutil.rmtree(evals)
        before = {str(p.relative_to(workspace)): digest(p) for p in workspace.rglob('*') if p.is_file()}
        home = slot / 'home'
        home.mkdir()
        (home / 'settings.yaml').write_text(json.dumps({'agent-default-model': {
            'provider': 'deepseek-official', 'model': args.model, 'reasoningEffort': 'high'}}))
        patch = [
            {'id': 'sandbox-policy', 'config': {'mode': 'read-only'}},
            {'id': 'approval', 'config': {'policy': 'never'}},
            {'id': 'agent-instructions', 'config': {'maxBytes': 65536, 'projectRootMarkers': ['pnpm-workspace.yaml'], 'dshHome': str(slot / 'agents')}},
            {'insert': [{'id': 'file-reference-treatment', 'name': str(frozen / 'treatment.mjs'),
                         'config': {'promptFile': str(frozen / 'prompts' / (variant + '.txt'))}}]},
        ]
        overlay = slot / 'overlay.yml'
        overlay.write_text(json.dumps(patch))
        command = ['env', 'DSH_HOME=' + str(home), 'DSH_AGENTS_HOME=' + str(slot / 'agents'),
                   'node', *env_args, str(launcher), '--profile', 'headless', '--patch', str(overlay), '--json', '-']
        task = frozen / 'cases' / (case + '.txt')
        result = execute(command, workspace, task, slot, args.timeout)
        after = {str(p.relative_to(workspace)): digest(p) for p in workspace.rglob('*') if p.is_file()}
        changed = sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k))
        (slot / 'workspace-audit.json').write_text(json.dumps({'unchanged': not changed, 'changedFiles': changed}, indent=2) + '\n')
        print(json.dumps({'run': name, **result, 'workspaceUnchanged': not changed}), flush=True)
        if result['exitCode'] != 0 or result['timedOut'] or result['interrupted'] or result['outputError'] or result['teardownError'] or not result['nonemptyFinal'] or changed:
            (output / 'stop.json').write_text(json.dumps({'failed': name, 'unstarted': names[names.index(name) + 1:]}, indent=2) + '\n')
            raise SystemExit(1)


if __name__ == '__main__':
    main()

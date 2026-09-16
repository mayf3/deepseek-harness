"""Aggregate reviewed occurrence counts without treating unreviewed answers as passes."""
import argparse
import json
from pathlib import Path
from run import digest


def observations(source):
    """Read historical records or join fresh outputs with hash-bound human annotations."""
    if source.is_file():
        return json.loads(source.read_text())['runs']
    manifest = json.loads((source / 'manifest.json').read_text())
    rows = []
    for name in manifest['runs']:
        slot = source / name
        if not (slot / 'execution.json').exists():
            if (slot / 'stdout.jsonl').exists():
                raise ValueError(f'{name}: incomplete execution record; inspect retained output')
            rows.append({'name': name, 'unstarted': True})
            continue
        row = {'name': name, **json.loads((slot / 'execution.json').read_text()), 'counts': None}
        annotation = slot / 'annotation.json'
        if annotation.exists():
            review = json.loads(annotation.read_text())
            if not row['nonemptyFinal'] or not review['finalSha256'] == row['finalSha256'] == digest(slot / 'final.md'):
                raise ValueError(f'{name}: annotation does not match the preserved final answer')
            row['counts'] = review['counts']
        rows.append(row)
    return rows


def aggregate(rows):
    """Keep execution and content denominators separate; reject invalid ledgers."""
    result = {}
    seen = set()
    for row in rows:
        name = row['name']
        if name in seen:
            raise ValueError(f'Duplicate attempt: {name}')
        seen.add(name)
        variant = name.rsplit('-', 1)[0].split('-', 1)[1]
        group = result.setdefault(variant, dict(planned=0, attempted=0, completed=0, timedOut=0,
                                               audited=0, unreviewed=0, perfect=0, E=0, L=0, M=0, I=0))
        group['planned'] += 1
        if row.get('unstarted'):
            continue
        group['attempted'] += 1
        group['completed'] += int(row['nonemptyFinal'])
        group['timedOut'] += int(row['timedOut'])
        counts = row.get('counts')
        if counts is None:
            group['unreviewed'] += int(row['nonemptyFinal'])
            continue
        if not row['nonemptyFinal']:
            raise ValueError(f'{name}: an absent final answer cannot have content counts')
        if any(type(counts.get(k)) is not int or counts[k] < 0 for k in ['E', 'L', 'M', 'I']):
            raise ValueError(f'{name}: E/L/M/I must be nonnegative integers')
        if counts['E'] != counts['L'] + counts['M'] + counts['I']:
            raise ValueError(f'{name}: E must equal L + M + I')
        group['audited'] += 1
        group['perfect'] += int(counts['E'] > 0 and counts['M'] == counts['I'] == 0)
        for key in ['E', 'L', 'M', 'I']:
            group[key] += counts[key]
    return result


def main():
    """Print the same compact result table for archived and newly reviewed cohorts."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, help='Run directory or historical observations.json')
    args = parser.parse_args()
    groups = aggregate(observations(args.source))
    print('| Prompt | Answers / attempts / planned | Audited | Unreviewed | L/E | Missing / invalid | Perfect | Timeouts |')
    print('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for variant, row in groups.items():
        rate = f"{row['L']}/{row['E']} ({row['L'] / row['E']:.1%})" if row['E'] else 'inactive'
        print(f"| {variant} | {row['completed']}/{row['attempted']}/{row['planned']} | {row['audited']} | {row['unreviewed']} | {rate} | {row['M']} / {row['I']} | {row['perfect']} | {row['timedOut']} |")


if __name__ == '__main__':
    main()

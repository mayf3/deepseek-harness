/** Recorded ACP protocol behavior through the shipped `dsh --profile acp` interface. */

import { fileURLToPath } from 'node:url'
import {
  defineAcpSnapshotSuite,
  type Scenario,
  type SnapshotSuiteOptions,
} from '@deepseek-ai/dsh-session-snapshot'

const corpusDir = fileURLToPath(new URL('./', import.meta.url))
const compositionDir = fileURLToPath(new URL('./escalation-approved/', import.meta.url))

function snapshotMode(value: string | undefined): SnapshotSuiteOptions['mode'] {
  switch (value) {
    case undefined:
    case '':
    case 'replay': return 'replay'
    case 'record': return 'record'
    case 'refresh': return 'refresh'
    default: throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

const scenarios: Scenario[] = [
  { name: 'handshake', hasModelTurn: false, recorded: false, headerClass: 'sandbox' },
  { name: 'reject-extra-dirs', hasModelTurn: false, recorded: false, headerClass: 'sandbox' },
  { name: 'cancel', hasModelTurn: true, recorded: false, overridden: true, headerClass: 'sandbox' },
  { name: 'cancel-tool-calls', hasModelTurn: true, recorded: false, overridden: true, headerClass: 'sandbox', posixOnly: true },
  {
    name: 'escalation-approved',
    hasModelTurn: true,
    recorded: true,
    pinsHeader: true,
    headerClass: 'sandbox',
    env: { DSH_PERMISSION_MODE: 'workspace-write' },
  },
  {
    name: 'escalation-rejected',
    hasModelTurn: true,
    recorded: true,
    headerClass: 'sandbox',
    env: { DSH_PERMISSION_MODE: 'workspace-write' },
  },
  {
    name: 'fs-escalation-approved',
    hasModelTurn: true,
    recorded: true,
    headerClass: 'sandbox',
    env: { DSH_PERMISSION_MODE: 'workspace-write' },
  },
]

defineAcpSnapshotSuite({
  agent: {
    binScript: fileURLToPath(new URL('../../apps/cli/src/bin.ts', import.meta.url)),
    configPath: fileURLToPath(new URL('./escalation-approved/cordis.yml', import.meta.url)),
    profile: 'acp',
    tsconfigPath: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
  },
  snapshotsDir: corpusDir,
  scenarios,
  mode: snapshotMode(process.env.DSH_SNAPSHOT),
})

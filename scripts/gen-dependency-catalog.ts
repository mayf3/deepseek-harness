/** Generate the README npx dependency catalog from a recorded public npm resolution. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { execa } from 'execa'
import { gitBlobHash, storeGitBlob } from './translation-pairing-git.ts'
import { renderTranslationPairingRecord, translationPairPaths } from './translation-pairing-record.ts'

const ROOT = resolve(import.meta.dirname, '..')
const PACKAGE = '@deepseek-ai/dsh'
const ENTRY = `node_modules/${PACKAGE}`
const REGISTRY = 'https://registry.npmjs.org/'
const LOCK = 'scripts/dependency-catalog/package-lock.json'
const METADATA = 'scripts/dependency-catalog/resolution.json'
const PATHS = translationPairPaths('docs/dependency-catalog.md')
type Locale = 'en' | 'zh'

/** npm lockfile fields used to describe an installed package or optional candidate. */
interface PackageEntry {
  name?: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  dev?: boolean
  optional?: boolean
  peer?: boolean
  os?: string[]
  cpu?: string[]
  libc?: string[]
}

/** One package location in npm's resolved tree; duplicate versions retain their locations. */
export interface DependencyRow {
  readonly location: string
  readonly name: string
  readonly version: string
  readonly direct: boolean
  readonly optional: boolean
  readonly peer: boolean
  readonly platforms: string
}

interface ResolutionMetadata {
  capturedAt: string
  npm: string
  node: string
  platform: string
  arch: string
  registry: string
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`dependency-catalog: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`dependency-catalog: ${label} must be a nonempty single-line value`)
  }
  return value
}

function parseEntry(value: unknown, location: string): PackageEntry {
  const raw = record(value, location)
  const entry: PackageEntry = { version: string(raw['version'], `${location} version`) }
  if (raw['name'] !== undefined) entry.name = string(raw['name'], `${location} name`)
  if (raw['link'] === true) throw new Error(`dependency-catalog: ${location} is a local link`)
  for (const key of ['dev', 'optional', 'peer'] as const) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') throw new Error(`dependency-catalog: ${location} ${key} must be boolean`)
    entry[key] = raw[key]
  }
  for (const key of ['dependencies', 'optionalDependencies'] as const) {
    if (raw[key] === undefined) continue
    entry[key] = Object.fromEntries(Object.entries(record(raw[key], `${location} ${key}`))
      .map(([name, spec]) => [string(name, 'dependency name'), string(spec, `${location} ${name}`)]))
  }
  for (const key of ['os', 'cpu', 'libc'] as const) {
    const values = raw[key]
    if (values === undefined) continue
    if (!Array.isArray(values)) throw new Error(`dependency-catalog: ${location} ${key} must be an array`)
    entry[key] = values.map(value => string(value, `${location} ${key}`))
  }
  return entry
}

/**
 * Read npm's resolved production tree without substituting workspace or development dependencies.
 * @param input - Parsed npm lockfile v3 from a consumer with only dsh as its dependency.
 * @returns The CLI version and sorted package locations, excluding the synthetic consumer and CLI itself.
 */
export function collectDependencies(input: unknown): { version: string; rows: DependencyRow[] } {
  const lock = record(input, 'lockfile')
  if (lock['lockfileVersion'] !== 3) throw new Error('dependency-catalog: expected npm lockfileVersion 3')
  const packages = record(lock['packages'], 'packages')
  const consumer = record(packages[''], 'consumer')
  const requested = record(consumer['dependencies'], 'consumer dependencies')
  if (Object.keys(requested).length !== 1 || requested[PACKAGE] !== 'latest') {
    throw new Error(`dependency-catalog: consumer must request only ${PACKAGE}@latest`)
  }
  const entries = new Map(Object.entries(packages).filter(([location]) => location !== '')
    .map(([location, entry]) => [location, parseEntry(entry, location)]))
  const cli = entries.get(ENTRY)
  if (cli === undefined || cli.dev) throw new Error(`dependency-catalog: missing production ${PACKAGE}`)
  const direct = new Set<string>()
  for (const name of Object.keys({ ...cli.dependencies, ...cli.optionalDependencies })) {
    const location = [`${ENTRY}/node_modules/${name}`, `node_modules/${name}`]
      .find(candidate => entries.has(candidate))
    if (location === undefined) {
      if (cli.optionalDependencies?.[name] !== undefined) continue
      throw new Error(`dependency-catalog: missing direct dependency ${name}`)
    }
    direct.add(location)
  }
  const rows: DependencyRow[] = []
  for (const [location, entry] of entries) {
    if (location === ENTRY || entry.dev) continue
    const name = location.split('node_modules/').at(-1)
    if (name === undefined || !/^(@[^/]+\/)?[^/]+$/.test(name)) {
      throw new Error(`dependency-catalog: invalid npm package location ${location}`)
    }
    rows.push({
      location,
      name: entry.name ?? name,
      version: entry.version,
      direct: direct.has(location),
      optional: entry.optional === true,
      peer: entry.peer === true,
      platforms: (['os', 'cpu', 'libc'] as const)
        .flatMap(key => entry[key] === undefined ? [] : [`${key}: ${entry[key].join(', ')}`]).join('; '),
    })
  }
  if (rows.length === 0) throw new Error('dependency-catalog: empty dependency tree')
  rows.sort((a, b) => a.name.localeCompare(b.name, 'en')
    || a.version.localeCompare(b.version, 'en') || a.location.localeCompare(b.location, 'en'))
  return { version: cli.version, rows }
}

function readMetadata(scanRoot: string): ResolutionMetadata {
  const value = record(JSON.parse(readFileSync(resolve(scanRoot, METADATA), 'utf8')), 'resolution metadata')
  return {
    capturedAt: string(value['capturedAt'], 'capturedAt'),
    npm: string(value['npm'], 'npm'),
    node: string(value['node'], 'node'),
    platform: string(value['platform'], 'platform'),
    arch: string(value['arch'], 'arch'),
    registry: string(value['registry'], 'registry'),
  }
}

function renderCatalog(version: string, rows: readonly DependencyRow[], meta: ResolutionMetadata, locale: Locale): string {
  const zh = locale === 'zh'
  const unique = new Set(rows.map(row => `${row.name}@${row.version}`)).size
  const direct = rows.filter(row => row.direct)
  const transitive = rows.filter(row => !row.direct)
  const table = (selected: readonly DependencyRow[]): string[] => [
    zh ? '| 包 | 解析版本 | 安装条件 | 包声明的平台限制 |' : '| Package | Resolved version | Installation | Declared platform restrictions |',
    '| --- | --- | --- | --- |',
    ...selected.map((row) => {
      const flags = [row.optional ? (zh ? '可选' : 'Optional') : (zh ? '必需' : 'Required')]
      if (row.peer) flags.push(zh ? 'Peer 自动安装' : 'Auto-installed peer')
      return `| [\`${row.name}\`](https://www.npmjs.com/package/${row.name}/v/${row.version}) | \`${row.version}\` | ${flags.join('; ')} | ${row.platforms || '—'} |`
    }),
    '',
  ]
  return [
    '<!-- Generated by scripts/gen-dependency-catalog.ts. Do not edit by hand. -->',
    '',
    zh ? '# 依赖目录' : '# Dependency catalog',
    '',
    zh ? '[English](dependency-catalog.md) | 中文' : 'English | [中文](dependency-catalog.zh.md)',
    '',
    zh ? '## 摘要' : '## Summary',
    '',
    zh
      ? `查看 [README 中的 npm 命令](../README.zh.md)所安装的 \`${PACKAGE}\` 的直接和传递依赖。此记录中的 npm \`latest\` 版本为 **${version}**；共 ${rows.length} 个依赖安装位置，涉及 ${unique} 个不同的包与版本组合。`
      : `Look up the direct and transitive dependencies of \`${PACKAGE}\` installed by the [README npm command](../README.md). The recorded npm \`latest\` release is **${version}**; there are ${rows.length} dependency locations representing ${unique} distinct package/version pairs.`,
    '',
    zh ? '## 目录' : '## Table of Contents',
    '',
    zh ? '- [范围](#scope)' : '- [Scope](#scope)',
    zh ? '- [直接依赖](#direct-dependencies)' : '- [Direct dependencies](#direct-dependencies)',
    zh ? '- [传递依赖](#transitive-dependencies)' : '- [Transitive dependencies](#transitive-dependencies)',
    zh ? '- [重新生成](#regeneration)' : '- [Regeneration](#regeneration)',
    '',
    '<a id="scope"></a>',
    '',
    zh ? '## 范围' : '## Scope',
    '',
    '```sh',
    'npx @deepseek-ai/dsh web',
    '```',
    '',
    zh
      ? `采集时间：\`${meta.capturedAt}\`。解析工具：npm \`${meta.npm}\`，Node.js \`${meta.node}\`，\`${meta.platform}/${meta.arch}\`。Registry：${meta.registry}`
      : `Captured: \`${meta.capturedAt}\`. Resolver: npm \`${meta.npm}\`, Node.js \`${meta.node}\`, \`${meta.platform}/${meta.arch}\`. Registry: ${meta.registry}`,
    '',
    zh
      ? '此记录使用空白 npm 消费项目解析公开发布包，包含必需依赖、自动安装的 Peer 依赖及可选依赖候选项。`web` 参数选择启动模式，不会缩小 CLI 的安装依赖。仓库的开发依赖和未被引用的 workspace 包不在此范围内。'
      : 'This record resolves published packages in an empty npm consumer, including required dependencies, automatically installed peers, and optional dependency candidates. The `web` argument selects a launch mode; it does not narrow the CLI installation. Repository development dependencies and unreferenced workspace packages are outside this scope.',
    '',
    zh
      ? '可选项仅在平台匹配且安装成功时出现；经可选父包引入的依赖也可能被省略。平台列显示包自身的 `os`、`cpu` 和 `libc` 声明，`—` 表示包自身未声明限制。表格中的重复行保留 npm 在不同位置安装的相同包版本。此目录由仅生成 lockfile 的解析过程产生，不验证安装脚本或其下载的额外文件。'
      : 'Optional entries appear only when their platform matches and installation succeeds; dependencies reached through optional parents can also be omitted. The platform column shows each package’s own `os`, `cpu`, and `libc` declarations; `—` means no restriction declared by that package. Repeated rows retain identical package versions installed at different locations. This catalog comes from a lockfile-only resolution and does not verify install scripts or additional files they download.',
    '',
    zh
      ? '这是带时间的解析记录：npm 的 tag、版本范围、npm/Node.js 版本、平台、配置及现有本地安装或缓存均可能改变实际结果。普通生成和 CI 检查使用提交的记录；只有刷新命令查询 registry。参见 [npx 文档](https://docs.npmjs.com/cli/v11/commands/npx/)和 [npm lockfile 文档](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/)。'
      : 'This is a dated resolution: npm tags, version ranges, npm/Node.js versions, platform, configuration, and existing local installations or caches can change the actual result. Normal generation and CI checks use the committed record; only the refresh command queries the registry. See the [npx documentation](https://docs.npmjs.com/cli/v11/commands/npx/) and [npm lockfile documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/).',
    '',
    '<a id="direct-dependencies"></a>',
    '',
    zh ? '## 直接依赖' : '## Direct dependencies',
    '',
    zh ? `${direct.length} 个安装位置由已发布 CLI 的依赖字段直接引用。` : `${direct.length} locations are referenced directly by the published CLI dependency fields.`,
    '',
    ...table(direct),
    '<a id="transitive-dependencies"></a>',
    '',
    zh ? '## 传递依赖' : '## Transitive dependencies',
    '',
    zh ? `${transitive.length} 个其余安装位置由依赖树引入。` : `${transitive.length} further locations are brought in by the dependency tree.`,
    '',
    ...table(transitive),
    '<a id="regeneration"></a>',
    '',
    zh ? '## 重新生成' : '## Regeneration',
    '',
    zh
      ? '在已安装依赖的仓库中，从提交的 npm 记录重新生成两种语言的目录和配对记录：'
      : 'In an installed repository checkout, regenerate both languages and the pairing record from the committed npm resolution:',
    '',
    '```sh',
    'pnpm run gen-dependency-catalog',
    'pnpm run verify-dependency-catalog',
    '```',
    '',
    zh ? '从公开 npm registry 刷新 `latest` 及其完整依赖树，然后重新生成目录：' : 'Refresh `latest` and its complete dependency tree from the public npm registry, then regenerate the catalog:',
    '',
    '```sh',
    'pnpm run gen-dependency-catalog --refresh',
    '```',
    '',
    zh
      ? `提交 [npm lockfile](../${LOCK})、[解析元数据](../${METADATA})和三个目录配对文件。刷新使用临时目录并禁用安装脚本；失败时不替换已提交的解析记录。\`doc-sync\` 检查生成文件是否与记录一致。`
      : `Commit the [npm lockfile](../${LOCK}), [resolution metadata](../${METADATA}), and all three catalog pair files. Refresh uses a temporary directory with install scripts disabled; a failed resolution leaves the committed record intact. \`doc-sync\` checks generated files against the record.`,
    '',
  ].join('\n')
}

/**
 * Compute all catalog artifacts without network access or writes.
 * @param scanRoot - Repository root containing the recorded npm resolution.
 * @returns Repository-relative paths and their deterministic contents.
 */
export function computeDependencyCatalogOutputs(scanRoot: string = ROOT): ReadonlyMap<string, string> {
  const { version, rows } = collectDependencies(JSON.parse(readFileSync(resolve(scanRoot, LOCK), 'utf8')))
  const metadata = readMetadata(scanRoot)
  const en = renderCatalog(version, rows, metadata, 'en')
  const zh = renderCatalog(version, rows, metadata, 'zh')
  return new Map([
    [PATHS.source, en],
    [PATHS.zh, zh],
    [PATHS.meta, renderTranslationPairingRecord(PATHS, {
      sourceHash: gitBlobHash(Buffer.from(en)),
      zhHash: gitBlobHash(Buffer.from(zh)),
    })],
  ])
}

/**
 * Check every generated document and pairing record against the npm resolution.
 * @param scanRoot - Repository root containing the resolution and generated files.
 * @returns Paths with missing or stale generated contents.
 */
export function staleDependencyCatalogPaths(scanRoot: string = ROOT): string[] {
  return [...computeDependencyCatalogOutputs(scanRoot)]
    .filter(([path, content]) => !existsSync(resolve(scanRoot, path)) || readFileSync(resolve(scanRoot, path), 'utf8') !== content)
    .map(([path]) => path)
}

async function refreshResolution(): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-dependency-catalog-'))
  try {
    writeFileSync(join(temporary, 'package.json'), `${JSON.stringify({
      name: 'dsh-dependency-catalog', version: '0.0.0', private: true, dependencies: { [PACKAGE]: 'latest' },
    }, null, 2)}\n`)
    const options = { cwd: temporary, env: { npm_config_user_agent: undefined }, timeout: 300_000 }
    const { stdout: npm } = await execa('npm', ['--version'], options)
    await execa('npm', [
      'install', '--package-lock-only', '--lockfile-version=3', '--ignore-scripts', '--no-audit', '--no-fund',
      '--include=prod', '--include=optional', '--include=peer', '--legacy-peer-deps=false', `--registry=${REGISTRY}`,
    ], options)
    const lock = readFileSync(join(temporary, 'package-lock.json'), 'utf8')
    collectDependencies(JSON.parse(lock))
    const metadata: ResolutionMetadata = {
      capturedAt: new Date().toISOString(), npm, node: process.versions.node,
      platform: process.platform, arch: process.arch, registry: REGISTRY,
    }
    mkdirSync(resolve(ROOT, dirname(LOCK)), { recursive: true })
    writeFileSync(resolve(ROOT, LOCK), lock)
    writeFileSync(resolve(ROOT, METADATA), `${JSON.stringify(metadata, null, 2)}\n`)
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 })
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, refresh: { type: 'boolean' } } })
  if (values.check && values.refresh) throw new Error('dependency-catalog: --check cannot refresh the registry record')
  if (values.refresh) await refreshResolution()
  if (values.check) {
    const stale = staleDependencyCatalogPaths()
    if (stale.length > 0) {
      throw new Error(`dependency-catalog: stale ${stale.join(', ')}; run pnpm run gen-dependency-catalog`)
    }
    console.log('dependency-catalog: all 3 artifacts match the recorded npm resolution')
    return
  }
  for (const [path, content] of computeDependencyCatalogOutputs()) {
    if (path.endsWith('.md')) storeGitBlob(ROOT, Buffer.from(content))
    writeFileSync(resolve(ROOT, path), content)
  }
  console.log('dependency-catalog: generated both languages and the pairing record')
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()

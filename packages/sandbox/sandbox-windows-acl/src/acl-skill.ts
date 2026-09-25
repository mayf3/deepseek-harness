/**
 * Registers the bundled Windows sandbox ACL diagnosis skill.
 *
 * The skill ships beside the backend whose failures it explains, so the assets
 * resolve relative to this module exactly as `skill-office` resolves its own. The
 * command-line side of the ACL backend never imports it: only the always-composed
 * local sandbox provider calls {@link registerAclDiagnosisSkill}, and only where
 * this backend can be the active one.
 *
 * @module @deepseek-ai/dsh-sandbox-windows-acl
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'

/** Bundled skill that diagnoses Windows sandbox ACL failures. */
export const ACL_DIAGNOSIS_SKILL = 'diagnose-windows-sandbox-acl'

/** Provider name this module registers the skill under. */
const PROVIDER = 'dsh-windows-acl'

function parseSkill(raw: string, path: string): { description: string; content: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter?.[1] === undefined) throw new Error(`dsh-sandbox-windows-acl: ${path} has no YAML frontmatter`)
  const metadata: unknown = parseYaml(frontmatter[1])
  const description = typeof metadata === 'object' && metadata !== null && 'description' in metadata
    ? metadata.description
    : undefined
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`dsh-sandbox-windows-acl: ${path} has no description`)
  }
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

/**
 * Register the bundled diagnosis skill on a session's skill registry.
 * @param ctx - Context carrying the skill registry.
 */
export function registerAclDiagnosisSkill(ctx: Context): void {
  const directory = fileURLToPath(new URL(`../assets/${ACL_DIAGNOSIS_SKILL}/`, import.meta.url))
  const locator = join(directory, 'SKILL.md')
  const { description } = parseSkill(readFileSync(locator, 'utf8'), locator)
  const candidate: SkillCandidate = {
    name: ACL_DIAGNOSIS_SKILL,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: directory },
    locator,
  }
  const provider: SkillProvider = {
    name: PROVIDER,
    list: () => Promise.resolve([candidate]),
    async get(entry, options) {
      const { rank: _rank, locator: entryPath, ...summary } = entry
      const raw = await readFile(entryPath as string, { encoding: 'utf8', signal: options.signal })
      return { ...summary, content: parseSkill(raw, entryPath as string).content }
    },
  }
  ctx.skills.registerProvider(() => provider)
}

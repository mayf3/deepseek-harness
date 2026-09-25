/**
 * The Windows ACL diagnosis skill ships as assets, so its catalog entry and the
 * body the registry hands a model are asserted here rather than through a session.
 * The registration is exercised on a real skill registry fiber, which is also what
 * proves disposal removes the candidate.
 */

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import { ACL_DIAGNOSIS_SKILL, registerAclDiagnosisSkill } from '../src/acl-skill.ts'

describe('bundled Windows ACL diagnosis skill', () => {
  it('registers the packaged body and removes the candidate on disposal', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin({
        name: 'acl-skill-registration',
        inject: ['skills'],
        apply: (inner: Context) => { registerAclDiagnosisSkill(inner) },
      })

      const catalog = await ctx.skills.list()
      expect(catalog.map(skill => skill.name)).toEqual([ACL_DIAGNOSIS_SKILL])
      const entry = catalog[0]!
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.description.length).toBeLessThanOrEqual(500)
      expect(entry).toMatchObject({
        source: 'bundled',
        provider: 'dsh-windows-acl',
        invocation: { modelInvocable: true, userInvocable: true },
      })

      const loaded = await ctx.skills.get(ACL_DIAGNOSIS_SKILL)
      expect(loaded?.resourceBase).toMatchObject({ kind: 'directory' })
      // The body names the bundled script — the repair path the model must use
      // instead of editing ACLs by hand.
      expect(loaded?.content).toContain('scripts/diagnose-windows-sandbox-acl.ps1')
      expect(loaded?.content).toContain('Step 4')

      await fiber.dispose()
      expect(await ctx.skills.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

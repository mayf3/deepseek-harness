/**
 * Design-owned presentation of the composer menu (design doc for #3567):
 * the two sections with their usage order, and the client face of the
 * built-in Host commands — localized title, description, claim token, and
 * icon — whose catalog descriptors carry English text only. A catalog row is
 * the built-in command when its description equals the canonical English
 * text; a scoped override or third-party command of the same name keeps its
 * own description and title, and only its section position follows the name.
 */
import type { ComponentType } from 'react'
import type { InputTriggerCandidate } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  IconCompactOutline16, IconDownloadOutline16, IconGoalOutline16, IconPlanOutline14, IconSendOutline16,
  IconShieldOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { en, zh } from './locales.ts'
import type { CommandKey } from './locales.ts'

/** The menu's two sections. */
export type MenuSection = 'add' | 'commands'

/** Row names per section, highest usage first; rows outside both lists close the Commands section in catalog order. */
export const SECTION_ROWS: Readonly<Record<MenuSection, readonly string[]>> = {
  add: ['file', 'goal', 'plan', 'feedback'],
  commands: ['compact', 'permission', 'model', 'export'],
}

/** The dictionary keys and glyph of one built-in Host command's client face. */
interface HostFace {
  readonly label: CommandKey
  readonly description: CommandKey
  readonly token: CommandKey
  readonly icon: ComponentType<IconProps>
}

/** One built-in Host command's face, keyed by its dictionary entries. */
function hostFace(name: string, icon: ComponentType<IconProps>): readonly [string, HostFace] {
  return [name, {
    label: `label.${name}` as CommandKey,
    description: `description.${name}` as CommandKey,
    token: `token.${name}` as CommandKey,
    icon,
  }]
}

/** Built-in Host commands whose client face this package owns. */
const HOST_FACES: ReadonlyMap<string, HostFace> = new Map([
  hostFace('goal', IconGoalOutline16),
  hostFace('plan', IconPlanOutline14),
  hostFace('feedback', IconSendOutline16),
  hostFace('compact', IconCompactOutline16),
  hostFace('permission', IconShieldOutline16),
  hostFace('export', IconDownloadOutline16),
])

/** The face of the built-in command a catalog row is, or undefined when the description is not the canonical English text. */
function builtinFace(name: string, description: string): HostFace | undefined {
  const face = HOST_FACES.get(name)
  return face !== undefined && en[face.description] === description ? face : undefined
}

/**
 * The localized menu face of a catalog row.
 * @param name - catalog command name.
 * @param description - the catalog description.
 * @param t - the `command` namespace translator.
 * @returns title, description, and glyph for a built-in command; undefined
 * for any other row, which keeps its catalog description.
 */
export function builtinRowFace(
  name: string,
  description: string,
  t: TranslateNS<'command'>,
): Pick<InputTriggerCandidate, 'label' | 'description' | 'icon'> | undefined {
  const face = builtinFace(name, description)
  return face === undefined ? undefined : { label: t(face.label), description: t(face.description), icon: face.icon }
}

/**
 * The claim token of a catalog row in the current locale (the text the
 * composer shows after a pick): the localized token of a built-in command,
 * the name itself for any other row.
 * @param name - catalog command name.
 * @param description - the catalog description.
 * @param t - the `command` namespace translator.
 * @returns the token without its leading slash.
 */
export function claimToken(name: string, description: string, t: TranslateNS<'command'>): string {
  const face = builtinFace(name, description)
  return face === undefined ? name : t(face.token)
}

/** Every localized claim token of every dictionary → the command name it stands for. */
const TOKEN_ALIASES: ReadonlyMap<string, string> = new Map(
  [...HOST_FACES].flatMap(([name, face]) =>
    [zh[face.token], en[face.token]].filter(token => token !== name).map(token => [token, name] as const)),
)

/**
 * The command name a typed token stands for: a localized claim token of a
 * built-in command in any dictionary resolves to that command, so a draft
 * written under one locale still submits under another.
 * @param token - the typed name without its leading slash.
 * @returns the catalog command name.
 */
export function resolveCommandName(token: string): string {
  return TOKEN_ALIASES.get(token) ?? token
}

/**
 * Arrange the empty-query menu: the Add section, then the Commands section,
 * each in usage order, with unlisted rows closing Commands in their input
 * order; each row carries its section heading.
 * @param rows - the visible candidates in catalog-then-contribution order.
 * @param t - the `command` namespace translator.
 * @returns the sectioned rows.
 */
export function sectionRows(rows: readonly InputTriggerCandidate[], t: TranslateNS<'command'>): readonly InputTriggerCandidate[] {
  const listed = new Set([...SECTION_ROWS.add, ...SECTION_ROWS.commands])
  const byName = new Map(rows.map(row => [row.name, row]))
  const pick = (names: readonly string[]): InputTriggerCandidate[] =>
    names.flatMap((name) => {
      const row = byName.get(name)
      return row === undefined ? [] : [row]
    })
  const add = pick(SECTION_ROWS.add).map(row => ({ ...row, section: t('section.add') }))
  const commands = [...pick(SECTION_ROWS.commands), ...rows.filter(row => !listed.has(row.name))]
    .map(row => ({ ...row, section: t('section.commands') }))
  return [...add, ...commands]
}

/**
 * View-layer union of the host turn outline and the loaded rail items. The
 * conversation snapshot never carries projection values, so this merge is the
 * one place the rail's two sources meet: the `turnOutline` projection names
 * every turn of the session, and the loaded window supplies anchors and
 * richer previews for the turns it holds.
 */

import type {} from '@deepseek-ai/dsh-session-turn-outline/client'
import type { TurnNavigationItem } from '../contract/snapshot.ts'

/** One rail mark: a loaded Turn scrolls to its row; an unloaded one pages history through its seq first. */
export interface TurnRailItem {
  readonly turn: number
  /** Bounded prompt preview (loaded window first, outline fallback). */
  readonly prompt: string
  /** Bounded response preview; `''` for unloaded Turns (the outline carries prompts only). */
  readonly response: string
  /** How the rail reaches the Turn. */
  readonly anchor:
    | { readonly kind: 'loaded'; readonly key: string }
    | { readonly kind: 'unloaded'; readonly seq: number }
}

const EMPTY_ITEMS: readonly TurnRailItem[] = []

/** Structurally narrow one wire outline entry (projection values cross the wire). */
function outlineEntry(value: unknown): { turn: number; seq: number; prompt: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as { turn?: unknown; seq?: unknown; prompt?: unknown }
  if (typeof entry.turn !== 'number' || !Number.isSafeInteger(entry.turn) || entry.turn < 0) return undefined
  if (typeof entry.seq !== 'number' || !Number.isSafeInteger(entry.seq) || entry.seq < 0) return undefined
  if (typeof entry.prompt !== 'string') return undefined
  return { turn: entry.turn, seq: entry.seq, prompt: entry.prompt }
}

/** Wire outline entries, or none when the projection is absent or malformed. */
function outlineEntries(outline: unknown): readonly unknown[] {
  if (typeof outline !== 'object' || outline === null) return EMPTY_ITEMS
  const turns = (outline as { turns?: unknown }).turns
  return Array.isArray(turns) ? turns : EMPTY_ITEMS
}

/**
 * Merge the host outline with the loaded rail items into the full ladder.
 * A turn present in both sides keeps the loaded anchor and response, taking
 * the outline prompt only when the window started mid-Turn (empty loaded
 * preview); turns on one side only pass through. Result ascends by turn.
 * @param loaded - loaded-window rail items (timeline order).
 * @param outline - `turnOutline` projection value, treated as wire data.
 * @returns every known turn, ascending; a stable empty array when none.
 */
export function mergeTurnRailItems(
  loaded: readonly TurnNavigationItem[],
  outline: unknown,
): readonly TurnRailItem[] {
  const byTurn = new Map<number, TurnRailItem>()
  for (const raw of outlineEntries(outline)) {
    const entry = outlineEntry(raw)
    if (entry === undefined) continue
    byTurn.set(entry.turn, {
      turn: entry.turn,
      prompt: entry.prompt,
      response: '',
      anchor: { kind: 'unloaded', seq: entry.seq },
    })
  }
  for (const item of loaded) {
    const preview = byTurn.get(item.turn)
    byTurn.set(item.turn, {
      turn: item.turn,
      prompt: item.prompt !== '' ? item.prompt : preview?.prompt ?? '',
      response: item.response,
      anchor: { kind: 'loaded', key: item.anchorKey },
    })
  }
  if (byTurn.size === 0) return EMPTY_ITEMS
  return [...byTurn.values()].sort((left, right) => left.turn - right.turn)
}

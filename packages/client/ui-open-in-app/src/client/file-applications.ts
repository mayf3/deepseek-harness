/** File association reads shared by path previews and authorized delivery routes. */
import { useEffect, useState } from 'react'
import type { SessionWorkspacePathApplication } from '@deepseek-ai/dsh-api-session-controller/types'

/**
 * Refresh associations on target changes and explicit menu opening; discard cancelled reads.
 * @param target - path or authenticated route identifying the current file.
 * @param query - target-specific association reader.
 * @param enabled - whether a native desktop is available.
 * @returns metadata, initial loading state, failure state, and a refresh callback.
 */
export function useFileApplications(
  target: string,
  query: (target: string, signal: AbortSignal) => Promise<readonly SessionWorkspacePathApplication[] | null>,
  enabled: boolean,
): { apps: readonly SessionWorkspacePathApplication[]; loading: boolean; failed: boolean; refresh: () => void } {
  const [revision, setRevision] = useState(0)
  const [association, setAssociation] = useState<{
    target: string
    apps: readonly SessionWorkspacePathApplication[] | null
  } | null>(null)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    void query(target, controller.signal).then((apps) => {
      if (!controller.signal.aborted) setAssociation({ target, apps })
    })
    return () => { controller.abort() }
  }, [enabled, target, query, revision])
  const apps = association?.target === target ? association.apps : null
  return {
    apps: apps ?? [],
    loading: association?.target !== target,
    failed: association?.target === target && apps === null,
    refresh: () => { setRevision(value => value + 1) },
  }
}

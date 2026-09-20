// Resident conversation shell keeps the composer mounted across local-draft,
// blank-Session, and active-conversation views.

import type { ConversationSlotProps } from '../contract/slots.ts'
import { ConversationMainPanel } from './ConversationMainPanel.tsx'

/** Full props composed from the slot contract. */
export type ConversationRootProps = ConversationSlotProps

export function ConversationRoot(props: ConversationRootProps) {
  return <ConversationMainPanel {...props} />
}

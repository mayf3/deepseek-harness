/** Stable parent for one group's Node references, independent of display mode. */
import { memo, type ComponentProps } from 'react'
import type { GroupKey } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { chatRenderKey } from './render-entry.ts'
import css from './ChatGroupSeat.module.css'

type ChatGroupSeatProps = Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey' | 'groupPart'> & {
  readonly groupKey: GroupKey
  readonly useChatGroup: ChatViewSlotProps['useChatGroup']
}

/** Render the group's members without moving them between React parents on mode changes. */
export const ChatGroupSeat = memo(function ChatGroupSeat({ groupKey, useChatGroup, ...props }: ChatGroupSeatProps) {
  const members = useChatGroup(groupKey, group => group?.members)
  if (members === undefined) return null
  return (
    <div className={css.root} data-chat-group-key={groupKey}>
      {members.map(member => (
        <ChatNodeSeat
          {...props}
          key={chatRenderKey(member)}
          nodeKey={member.key}
          {...member.groupPart === undefined ? {} : { groupPart: member.groupPart }}
        />
      ))}
    </div>
  )
})

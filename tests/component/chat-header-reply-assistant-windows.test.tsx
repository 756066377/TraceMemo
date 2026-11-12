import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatHeader } from '../../src/renderer/src/components/chat/ChatHeader'
import { TooltipProvider } from '../../src/renderer/src/components/ui'
import type { Contact } from '../../src/shared/types'

vi.mock('../../src/renderer/src/utils/runtime-environment', () => ({
  runtimePlatform: 'win32',
  isMac: false,
  isWindows: true,
  supportsPersonalWechatSend: true
}))

const contact: Contact = {
  m_nsUsrName: 'wxid_friend',
  m_nsNickName: '好友',
  md5: 'u'.repeat(32),
  type: 'user'
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      getGroupMemberStats: vi.fn().mockResolvedValue(null),
      getPersonalWechatSenderStatus: vi.fn().mockResolvedValue({ canSendText: false })
    }
  })
})

describe('ChatHeader · Windows 回复助手入口', () => {
  it('Windows 当前会话有消息时显示并触发分析入口', async () => {
    const onAnalyzeReply = vi.fn()
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <ChatHeader
          contact={contact}
          isGroupChat={false}
          loadedCount={10}
          filteredCount={10}
          contentFilter=""
          isAiLoading={false}
          onContentFilterChange={vi.fn()}
          onTestSend={vi.fn()}
          onOpenAiSettings={vi.fn()}
          onAnalyzeReply={onAnalyzeReply}
        />
      </TooltipProvider>
    )

    const button = screen.getByRole('button', { name: '分析并起草' })
    expect(button).toBeEnabled()
    await user.click(button)
    expect(onAnalyzeReply).toHaveBeenCalledTimes(1)
  })
})

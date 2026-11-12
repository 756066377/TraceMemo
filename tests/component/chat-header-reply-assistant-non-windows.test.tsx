import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatHeader } from '../../src/renderer/src/components/chat/ChatHeader'
import { TooltipProvider } from '../../src/renderer/src/components/ui'
import type { Contact } from '../../src/shared/types'

vi.mock('../../src/renderer/src/utils/runtime-environment', () => ({
  runtimePlatform: 'darwin',
  isMac: true,
  isWindows: false,
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

describe('ChatHeader · 非 Windows 不暴露回复助手', () => {
  it('即使传入回调，也不渲染 Windows-only 入口', () => {
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
          onAnalyzeReply={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(screen.queryByRole('button', { name: '分析并起草' })).toBeNull()
  })
})

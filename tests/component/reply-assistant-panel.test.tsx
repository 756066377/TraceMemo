import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReplyAssistantPanel } from '../../src/renderer/src/components/chat/ReplyAssistantPanel'
import type { Contact } from '../../src/shared/types'
import type { PersonalWechatSenderStatus } from '../../src/shared/personal-wechat'
import type { ReplyAssistantResult } from '../../src/shared/reply-assistant'
import type { RelationshipProfile } from '../../src/shared/relationship-profile'

const contact: Contact = {
  m_nsUsrName: 'wxid_friend',
  m_nsNickName: '好友',
  md5: 'u'.repeat(32),
  type: 'user'
}

const senderStatus: PersonalWechatSenderStatus = {
  state: 'online',
  platform: 'win32',
  arch: 'x64',
  sipDisabled: true,
  wechatRunning: true,
  endpoint: '127.0.0.1:12345',
  endpointReady: true,
  runtimeReady: true,
  attachReady: true,
  baseAddressReady: true,
  textHookInstalled: true,
  textHookReady: true,
  imageHookInstalled: true,
  imageHookReady: true,
  messageListenerReady: true,
  canSend: true,
  canSendText: true,
  canSendImage: true,
  canSendVoice: true,
  message: '已就绪'
}

const profile: RelationshipProfile = {
  userMd5: contact.md5,
  type: '同事',
  stage: '了解中',
  goal: '主动邀约',
  note: '同部门',
  updatedAt: 1
}

const analysisResult: ReplyAssistantResult = {
  success: true,
  source: 'wechat_database',
  contextSize: 20,
  messageCount: 3,
  sourceMessageIds: ['a', 'b', 'c'],
  blocked: false,
  candidates: ['我九点到', '晚点把地址发你', '好'],
  bestIndex: 0,
  scores: [0.6, 0.3, 0.1],
  scoreMethod: 'model_relative_weights',
  brief: {
    facts: ['对方：「明天几点见」'],
    intent: '可能是想确认安排',
    intentConfidence: 0.58,
    action: '本轮主策略：承接',
    unknown: '是否还有其他人参加',
    nextStep: '先核对原文，再按主策略选择候选。',
    stopCondition: '对方明确拒绝时停止推进。',
    evidenceNote: '引文来自本地微信数据库；候选权重不是回复成功率。'
  },
  strategy: {
    strategy: '承接',
    confidence: 0.58,
    intent: '想确认安排',
    facts: ['对方问了几点'],
    unknowns: ['是否还有别人'],
    method: 'configured_ai_provider'
  },
  usage: { input: 10, output: 5, total: 15, estimated: false, calls: 3 },
  relationship: { context: '关系类型：同事', type: '同事', stage: '了解中', goal: '主动邀约' },
  provider: { providerName: '本地假服务', model: 'fixture-model', configured: true }
}

let analyzeReply: ReturnType<typeof vi.fn>
let saveRelationshipProfile: ReturnType<typeof vi.fn>
let sendPersonalWechatMessage: ReturnType<typeof vi.fn>

afterEach(() => vi.useRealTimers())

beforeEach(() => {
  analyzeReply = vi.fn().mockResolvedValue(analysisResult)
  saveRelationshipProfile = vi.fn().mockResolvedValue({ success: true, profile })
  sendPersonalWechatMessage = vi.fn().mockResolvedValue({
    success: true,
    status: senderStatus,
    attempts: 1,
    segments: 1,
    sentSegments: 1
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      analyzeReply,
      saveRelationshipProfile,
      getRelationshipProfile: vi.fn().mockResolvedValue(profile),
      listRelationshipProfiles: vi.fn().mockResolvedValue([profile]),
      removeRelationshipProfile: vi.fn().mockResolvedValue({ success: true }),
      getPersonalWechatSenderStatus: vi.fn().mockResolvedValue(senderStatus),
      sendPersonalWechatMessage
    } as unknown as typeof window.api
  })
})

describe('分析并起草面板', () => {
  it('渲染为非模态侧栏，不是对话框', async () => {
    render(<ReplyAssistantPanel contact={contact} isGroupChat={false} onClose={vi.fn()} />)
    expect(screen.getByRole('complementary', { name: '分析与回复草稿' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(screen.getByLabelText('关系类型')).toHaveValue('同事'))
  })

  it('关系背景改为选项，切换后按联系人保存', async () => {
    const user = userEvent.setup()
    render(<ReplyAssistantPanel contact={contact} isGroupChat={false} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('关系类型')).toHaveValue('同事'))
    expect(screen.getByLabelText('关系阶段')).toHaveValue('了解中')
    expect(screen.getByLabelText('本轮目标')).toHaveValue('主动邀约')

    await user.selectOptions(screen.getByLabelText('关系阶段'), '暧昧')
    await waitFor(() =>
      expect(saveRelationshipProfile).toHaveBeenCalledWith(
        expect.objectContaining({ userMd5: contact.md5, stage: '暧昧' })
      )
    )
    expect(saveRelationshipProfile).toHaveBeenCalledWith(
      expect.objectContaining({ type: '同事', goal: '主动邀约', note: '同部门' })
    )
  })

  it('首次需要手动分析，并带上结构化的关系字段', async () => {
    const user = userEvent.setup()
    render(<ReplyAssistantPanel contact={contact} isGroupChat={false} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('关系类型')).toHaveValue('同事'))

    await user.click(screen.getByRole('button', { name: '开始分析' }))
    await waitFor(() => expect(analyzeReply).toHaveBeenCalledTimes(1))

    const request = analyzeReply.mock.calls[0][0]
    expect(request.userMd5).toBe(contact.md5)
    expect(request.relationshipType).toBe('同事')
    expect(request.relationshipStage).toBe('了解中')
    expect(request.relationshipGoal).toBe('主动邀约')
    expect(request).not.toHaveProperty('messages')
    expect(request).not.toHaveProperty('screenshot')
    expect(await screen.findByText('我九点到')).toBeInTheDocument()
  })

  it('手动分析一次后，对方新消息到达时自动重新分析', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <ReplyAssistantPanel
        contact={contact}
        isGroupChat={false}
        latestMessage={{ id: 'm1', createTime: 100, isSender: true }}
        onClose={vi.fn()}
      />
    )
    await waitFor(() => expect(screen.getByLabelText('关系类型')).toHaveValue('同事'))
    await user.click(screen.getByRole('button', { name: '开始分析' }))
    await waitFor(() => expect(analyzeReply).toHaveBeenCalledTimes(1))

    rerender(
      <ReplyAssistantPanel
        contact={contact}
        isGroupChat={false}
        latestMessage={{ id: 'm2', createTime: 200, isSender: false }}
        onClose={vi.fn()}
      />
    )
    await waitFor(() => expect(analyzeReply).toHaveBeenCalledTimes(2), { timeout: 9000 })
  })

  it('自己发出的新消息不会触发自动分析', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <ReplyAssistantPanel
        contact={contact}
        isGroupChat={false}
        latestMessage={{ id: 'm1', createTime: 100, isSender: false }}
        onClose={vi.fn()}
      />
    )
    await waitFor(() => expect(screen.getByLabelText('关系类型')).toHaveValue('同事'))
    await user.click(screen.getByRole('button', { name: '开始分析' }))
    await waitFor(() => expect(analyzeReply).toHaveBeenCalledTimes(1))

    rerender(
      <ReplyAssistantPanel
        contact={contact}
        isGroupChat={false}
        latestMessage={{ id: 'm2', createTime: 200, isSender: true }}
        onClose={vi.fn()}
      />
    )
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(analyzeReply).toHaveBeenCalledTimes(1)
  })

  it('手动分析已包含对方最新消息时，不为同一条消息重复自动调用', async () => {
    vi.useFakeTimers()
    const { unmount } = render(
      <ReplyAssistantPanel
        contact={contact}
        isGroupChat={false}
        latestMessage={{ id: 'already-included', createTime: 100, isSender: false }}
        onClose={vi.fn()}
      />
    )
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '开始分析' }))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8000)
      })
      expect(analyzeReply).toHaveBeenCalledTimes(1)
    } finally {
      unmount()
      vi.useRealTimers()
    }
  })

  it('逐条发送草稿，并把失败原因转成可执行提示', async () => {
    const user = userEvent.setup()
    sendPersonalWechatMessage = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        status: senderStatus,
        error: '发送失败：微信未登录',
        errorCode: 'not_ready'
      })
      .mockResolvedValueOnce({
        success: true,
        status: senderStatus,
        attempts: 1,
        segments: 1,
        sentSegments: 1
      })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...(window.api as unknown as Record<string, unknown>),
        sendPersonalWechatMessage
      }
    })
    render(<ReplyAssistantPanel contact={contact} isGroupChat={false} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('关系类型')).toHaveValue('同事'))
    await user.click(screen.getByRole('button', { name: '开始分析' }))
    expect(await screen.findByText('我九点到')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '发送候选 1 到微信' }))
    await waitFor(() => expect(sendPersonalWechatMessage).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/发送能力未就绪/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '发送候选 1 到微信' }))
    await waitFor(() => expect(sendPersonalWechatMessage).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发送候选 1 到微信' })).toHaveTextContent('已发送')
    )
  })

  it('可以先编辑候选再发送', async () => {
    const user = userEvent.setup()
    render(<ReplyAssistantPanel contact={contact} isGroupChat={false} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('关系类型')).toHaveValue('同事'))
    await user.click(screen.getByRole('button', { name: '开始分析' }))
    expect(await screen.findByText('我九点到')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '编辑候选 1' }))
    const editor = screen.getByLabelText('编辑候选 1')
    await user.clear(editor)
    await user.type(editor, '我九点到楼下')
    await user.click(screen.getByRole('button', { name: '发送编辑后的候选 1 到微信' }))

    await waitFor(() => expect(sendPersonalWechatMessage).toHaveBeenCalledTimes(1))
    expect(sendPersonalWechatMessage.mock.calls[0][0]).toMatchObject({
      type: 'text',
      text: '我九点到楼下',
      to: contact.m_nsUsrName
    })
  })

  it('显示已核对原文、消息时间、下一步、停止条件和所用资料', async () => {
    const user = userEvent.setup()
    analyzeReply.mockResolvedValue({
      ...analysisResult,
      strategy: {
        ...analysisResult.strategy,
        evidence: [
          {
            messageId: 'a',
            quote: '明天几点见',
            speaker: '同事甲',
            timestamp: 1_794_096_000_000
          }
        ]
      },
      knowledge: {
        version: 'test',
        status: 'partial',
        missingTopics: ['conflict'],
        sources: [{ id: 'core', title: '事实、边界与行动原则', digest: 'test' }]
      }
    })
    render(<ReplyAssistantPanel contact={contact} isGroupChat={false} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: '开始分析' }))
    expect(await screen.findByText('同事甲：「明天几点见」')).toBeInTheDocument()
    expect(screen.getByText(analysisResult.brief.nextStep)).toBeInTheDocument()
    expect(screen.getByText(analysisResult.brief.stopCondition)).toBeInTheDocument()
    expect(screen.getByText('事实、边界与行动原则')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('部分参考资料不可用')
    expect(document.querySelector('time')).toHaveAttribute(
      'datetime',
      new Date(1_794_096_000_000).toISOString()
    )
  })

  it('可以关闭比较，等权候选不展示伪推荐与成功率', async () => {
    const user = userEvent.setup()
    analyzeReply.mockResolvedValue({
      ...analysisResult,
      bestIndex: null,
      scoreMethod: 'equal_weights',
      scores: [1 / 3, 1 / 3, 1 / 3]
    })
    render(<ReplyAssistantPanel contact={contact} isGroupChat={false} onClose={vi.fn()} />)
    await user.click(screen.getByLabelText('比较候选回复'))
    await user.click(screen.getByRole('button', { name: '开始分析' }))
    await waitFor(() =>
      expect(analyzeReply).toHaveBeenCalledWith(
        expect.objectContaining({ rankCandidates: false, isGroupChat: false })
      )
    )
    expect(await screen.findAllByText(/未评出优先顺序/)).toHaveLength(3)
    expect(screen.queryByText(/本轮相对推荐/)).toBeNull()
  })

  it('会话切换后丢弃旧分析结果，不将旧关系档案带入新会话', async () => {
    const user = userEvent.setup()
    let finishOld!: (result: ReplyAssistantResult) => void
    analyzeReply.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        })
    )
    const { rerender } = render(
      <ReplyAssistantPanel contact={contact} isGroupChat={false} onClose={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByLabelText('关系类型')).toHaveValue('同事'))
    await user.click(screen.getByRole('button', { name: '开始分析' }))
    const nextContact = { ...contact, md5: 'next-contact', m_nsNickName: '新联系人' }
    window.api.getRelationshipProfile = vi.fn().mockResolvedValue({
      ...profile,
      userMd5: nextContact.md5,
      type: '客户',
      note: '项目往来'
    })
    rerender(<ReplyAssistantPanel contact={nextContact} isGroupChat={false} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('关系类型')).toHaveValue('客户'))
    finishOld({ ...analysisResult, candidates: ['旧联系人专属回复'] })
    await waitFor(() => expect(screen.getByRole('button', { name: '开始分析' })).toBeEnabled())
    expect(screen.queryByText('旧联系人专属回复')).toBeNull()
    await user.click(screen.getByRole('button', { name: '开始分析' }))
    await waitFor(() => expect(analyzeReply).toHaveBeenCalledTimes(2))
    expect(analyzeReply.mock.calls[1][0]).toMatchObject({
      userMd5: nextContact.md5,
      relationshipType: '客户',
      relationshipNote: '项目往来'
    })
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { AIChatRequestOptions } from '../../src/shared/ai-provider'
import type { ReplyAssistantDbMessage } from '../../src/shared/reply-assistant'
import {
  ReplyAssistantService,
  type ReplyAssistantAI
} from '../../src/main/services/reply-assistant-service'

const ANALYSIS_JSON = JSON.stringify({
  strategy: '承接',
  confidence: 0.58,
  intent: '想确认安排',
  facts: ['对方问了明天几点'],
  unknowns: ['是否还有其他人参加']
})
const DRAFT_JSON = JSON.stringify(['我九点到', '晚点把地址发你', '好'])
const RANK_JSON = JSON.stringify({
  scores: [
    { id: 0, score: 60 },
    { id: 1, score: 30 },
    { id: 2, score: 10 }
  ]
})

class FakeAI implements ReplyAssistantAI {
  readonly calls: Array<{
    messages: Array<{ role: string; content: string }>
    options?: AIChatRequestOptions
  }> = []

  constructor(
    private readonly responses: string[],
    private readonly configured = true
  ) {}

  getRuntimeConfig(): {
    providerName: string
    model: string
    configured: boolean
    timeoutMs?: number
  } {
    return {
      providerName: '测试 Provider',
      model: 'test-model',
      configured: this.configured,
      timeoutMs: 30_000
    }
  }

  async chat(
    messages: Array<{ role: string; content: string }>,
    options?: AIChatRequestOptions
  ): Promise<{
    success: boolean
    data?: string
    error?: string
    usage?: { input: number; output: number; total: number }
  }> {
    this.calls.push({ messages, options })
    const data = this.responses.shift()
    if (data === undefined) return { success: false, error: '没有预设响应' }
    return {
      success: true,
      data,
      usage: { input: 10, output: 5, total: 15 }
    }
  }
}

const normalRows: ReplyAssistantDbMessage[] = [
  { id: 'a', content: '明天几点见', isSender: false, createTime: 100 },
  { id: 'b', content: '我还不确定', isSender: true, createTime: 101 },
  { id: 'c', content: '你定好了说一声', isSender: false, createTime: 102 }
]

const boundaryRows: ReplyAssistantDbMessage[] = [
  { id: 'a', content: '就这样吧', isSender: true, createTime: 100 },
  { id: 'b', content: '请不要再联系我', isSender: false, createTime: 101 }
]

const createService = (
  rows: ReplyAssistantDbMessage[],
  ai: FakeAI,
  platform = 'win32'
): { service: ReplyAssistantService; loadMessages: ReturnType<typeof vi.fn> } => {
  const loadMessages = vi.fn(async (userMd5: string, limit: number) => {
    void userMd5
    void limit
    return rows
  })
  const service = new ReplyAssistantService({ platform, ai, loadMessages })
  return { service, loadMessages }
}

describe('ReplyAssistantService', () => {
  it('只从本地数据库读取当前会话，完成判断、草稿和排序', async () => {
    const ai = new FakeAI([ANALYSIS_JSON, DRAFT_JSON, RANK_JSON])
    const { service, loadMessages } = createService(normalRows, ai)

    const result = await service.analyze({ userMd5: 'conversation-md5', contextSize: 10 })

    expect(result.success).toBe(true)
    expect(result.source).toBe('wechat_database')
    expect(result.messageCount).toBe(3)
    expect(result.sourceMessageIds).toEqual(['a', 'b', 'c'])
    expect(result.candidates).toEqual(['我九点到', '晚点把地址发你', '好'])
    expect(result.bestIndex).toBe(0)
    expect(result.scores[0]).toBeCloseTo(0.6)
    expect(result.scoreMethod).toBe('model_relative_weights')
    expect(result.provider).toEqual({
      providerName: '测试 Provider',
      model: 'test-model',
      configured: true
    })
    expect(result.usage.calls).toBe(3)
    expect(loadMessages).toHaveBeenCalledTimes(1)
    expect(loadMessages.mock.calls[0][0]).toBe('conversation-md5')
    expect(loadMessages.mock.calls[0][1]).toBe(30)
    // 三次模型调用只携带主进程读取的数据库证据，不接受渲染层聊天数组。
    const payload = ai.calls.flatMap((call) => call.messages.map((item) => item.content)).join('\n')
    expect(payload).toContain('wechat_database')
    expect(payload).not.toContain('"messages"')
    expect(payload).toMatch(/明天几点见/)
  })

  it('明确边界不调用模型，也不生成候选', async () => {
    const ai = new FakeAI([ANALYSIS_JSON, DRAFT_JSON, RANK_JSON])
    const { service } = createService(boundaryRows, ai)

    const result = await service.analyze({ userMd5: 'boundary-md5' })

    expect(result.success).toBe(true)
    expect(result.blocked).toBe(true)
    expect(result.candidates).toEqual([])
    expect(result.strategy?.method).toBe('explicit_boundary')
    expect(result.brief.action).toBe('尊重对方停止联系的要求')
    expect(ai.calls).toHaveLength(0)
    expect(result.usage.calls).toBe(0)
  })

  it('非 Windows 平台直接拒绝，不读取数据库', async () => {
    const ai = new FakeAI([ANALYSIS_JSON, DRAFT_JSON, RANK_JSON])
    const { service, loadMessages } = createService(normalRows, ai, 'darwin')

    const result = await service.analyze({ userMd5: 'conversation-md5' })

    expect(result.success).toBe(false)
    expect(result.code).toBe('unsupported_platform')
    expect(loadMessages).not.toHaveBeenCalled()
    expect(ai.calls).toHaveLength(0)
  })

  it('Provider 未配置时停止在判断前', async () => {
    const ai = new FakeAI([ANALYSIS_JSON, DRAFT_JSON, RANK_JSON], false)
    const { service } = createService(normalRows, ai)

    const result = await service.analyze({ userMd5: 'conversation-md5' })

    expect(result.code).toBe('provider_unconfigured')
    expect(ai.calls).toHaveLength(0)
  })

  it('策略判断两次都不合法时不盲起草', async () => {
    const ai = new FakeAI(['不是 JSON', '仍然不是 JSON', DRAFT_JSON, RANK_JSON])
    const { service } = createService(normalRows, ai)

    const result = await service.analyze({ userMd5: 'conversation-md5' })

    expect(result.code).toBe('analysis_failed')
    expect(result.candidates).toEqual([])
    expect(ai.calls).toHaveLength(2)
  })

  it('草稿解析为空时停止，不伪造候选', async () => {
    const ai = new FakeAI([ANALYSIS_JSON, '[]', RANK_JSON])
    const { service } = createService(normalRows, ai)

    const result = await service.analyze({ userMd5: 'conversation-md5' })

    expect(result.code).toBe('draft_failed')
    expect(result.candidates).toEqual([])
    expect(ai.calls).toHaveLength(2)
  })

  it('结构化关系档案进入三次模型调用，并回显到结果', async () => {
    const ai = new FakeAI([ANALYSIS_JSON, DRAFT_JSON, RANK_JSON])
    const { service } = createService(normalRows, ai)

    const result = await service.analyze({
      userMd5: 'conversation-md5',
      relationshipType: '同事',
      relationshipStage: '了解中',
      relationshipGoal: '主动邀约',
      relationshipNote: '同部门'
    })

    expect(result.success).toBe(true)
    expect(result.relationship).toMatchObject({
      type: '同事',
      stage: '了解中',
      goal: '主动邀约'
    })
    expect(result.relationship?.context).toContain('本轮目标：主动邀约')

    const payloads = ai.calls.map((call) => call.messages.map((item) => item.content).join('\n'))
    for (const payload of payloads) {
      expect(payload).toContain('关系类型：同事')
      expect(payload).toContain('关系阶段：了解中')
    }
    // 目标约束只进起草提示，不替换策略判断本身。
    expect(payloads[1]).toContain('本轮目标约束')
  })

  it('只传自由文本关系背景时保持旧行为', async () => {
    const ai = new FakeAI([ANALYSIS_JSON, DRAFT_JSON, RANK_JSON])
    const { service } = createService(normalRows, ai)

    const result = await service.analyze({
      userMd5: 'conversation-md5',
      relationship: '相亲对象，第二次见面'
    })

    expect(result.success).toBe(true)
    expect(result.relationship?.context).toBe('相亲对象，第二次见面')
    expect(result.relationship?.type).toBe('')
    const payloads = ai.calls.map((call) => call.messages.map((item) => item.content).join('\n'))
    expect(payloads[0]).toContain('相亲对象，第二次见面')
  })

  it('完整保留长关系备注、消息身份与跨日时间，并在三个步骤共享同一份上下文', async () => {
    const ai = new FakeAI([ANALYSIS_JSON, DRAFT_JSON, RANK_JSON])
    const rows = normalRows.map((row, index) => ({
      ...row,
      createTime: 1_794_009_600 + index * 86_400,
      name: '同事甲',
      senderId: 'wxid_a'
    }))
    const { service } = createService(rows, ai)
    const note = `${'背景'.repeat(95)}最后不要承诺周末加班`
    const result = await service.analyze({
      userMd5: 'u',
      relationshipType: '同事',
      relationshipStage: '了解中',
      relationshipGoal: '自然接话',
      relationshipNote: note
    })
    expect(result.success).toBe(true)
    const payloads = ai.calls.map((call) => JSON.parse(call.messages[1].content))
    for (const payload of payloads) {
      expect(payload.relation_profile.note).toBe(note.slice(0, 200))
      expect(payload.relationship).toContain(note.slice(0, 200))
      expect(payload.transcript[0]).toMatchObject({
        id: 'a',
        from: 'her',
        speaker_id: 'wxid_a',
        timestamp: new Date(rows[0].createTime * 1000).toISOString()
      })
      expect(payload.reference_time).toEqual(payloads[0].reference_time)
      expect(payload.transcript).toEqual(payloads[0].transcript)
    }
  })

  it('模型虚构依据时重试，仍无效就停止起草', async () => {
    const bad = JSON.stringify({
      strategy: '约见',
      evidence: [{ messageId: 'a', quote: '我已经订好酒店' }]
    })
    const ai = new FakeAI([bad, bad, DRAFT_JSON])
    const { service } = createService(normalRows, ai)
    const result = await service.analyze({ userMd5: 'u' })
    expect(result.code).toBe('analysis_failed')
    expect(ai.calls).toHaveLength(2)
  })

  it('早先明确拒绝不会被自己随后发言覆盖，且简报引用拒绝原消息', async () => {
    const ai = new FakeAI([])
    const { service } = createService(
      [...boundaryRows, { id: 'c', content: '我再解释一句', isSender: true, createTime: 102 }],
      ai
    )
    const result = await service.analyze({ userMd5: 'u' })
    expect(result.blocked).toBe(true)
    expect(result.strategy?.evidence?.[0].messageId).toBe('b')
    expect(ai.calls).toHaveLength(0)
  })

  it('关闭比较时减少一次模型调用，等权候选不假装有最优项', async () => {
    const ai = new FakeAI([ANALYSIS_JSON, DRAFT_JSON])
    const { service } = createService(normalRows, ai)
    const result = await service.analyze({ userMd5: 'u', rankCandidates: false })
    expect(result.success).toBe(true)
    expect(ai.calls).toHaveLength(2)
    expect(result.bestIndex).toBeNull()
    expect(result.scoreMethod).toBe('equal_weights')
  })

  it('评分不可用时保留草稿但不伪造推荐顺序', async () => {
    const ai = new FakeAI([ANALYSIS_JSON, DRAFT_JSON, '无效评分'])
    const { service } = createService(normalRows, ai)
    const result = await service.analyze({ userMd5: 'u' })
    expect(result.success).toBe(true)
    expect(result.bestIndex).toBeNull()
  })

  it('模型给出并列最高分时不指定唯一最佳候选', async () => {
    const ai = new FakeAI([
      ANALYSIS_JSON,
      DRAFT_JSON,
      '{"scores":[{"id":0,"score":60},{"id":1,"score":60},{"id":2,"score":10}]}'
    ])
    const { service } = createService(normalRows, ai)
    const result = await service.analyze({ userMd5: 'u' })
    expect(result.success).toBe(true)
    expect(result.bestIndex).toBeNull()
    expect(result.scoreMethod).toBe('model_relative_weights')
  })

  it('资料加载失败时保留基础分析并明确标记不可用', async () => {
    const ai = new FakeAI([ANALYSIS_JSON, DRAFT_JSON, RANK_JSON])
    const service = new ReplyAssistantService({
      platform: 'win32',
      ai,
      loadMessages: async () => normalRows,
      knowledge: {
        load: async () => {
          throw new Error('missing')
        }
      }
    })
    const result = await service.analyze({ userMd5: 'u' })
    expect(result.success).toBe(true)
    expect(result.knowledge?.status).toBe('unavailable')
    expect(ai.calls[0].messages[0].content).toContain('只依据可见对话')
  })
})

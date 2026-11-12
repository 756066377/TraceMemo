import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import type {
  ReplyAssistantRequest,
  ReplyAssistantResult,
  ReplyAssistantStrategy
} from '../../src/shared/reply-assistant'

const root = mkdtempSync(join(tmpdir(), 'reply-live-eval-'))
vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { AIProviderService } from '../../src/main/services/ai-provider-service'
import { ReplyAssistantService } from '../../src/main/services/reply-assistant-service'
import { ReplyAssistantKnowledgeService } from '../../src/main/services/reply-assistant-knowledge-service'

interface Scenario {
  id: string
  text: string[]
  request: Partial<ReplyAssistantRequest>
  allowed: ReplyAssistantStrategy[]
  blocked?: boolean
}

const scenarios: Scenario[] = [
  {
    id: 'casual',
    text: ['今天方案又改了一天，累死了'],
    request: { relationshipType: '朋友' },
    allowed: ['承接', '降压', '澄清']
  },
  {
    id: 'customer',
    text: ['合同条款还没确认，请先别承诺交付日期'],
    request: { relationshipType: '客户' },
    allowed: ['承接', '澄清', '降压']
  },
  {
    id: 'conflict',
    text: ['我昨天没按约定回复你', '你答应了又没做到，我很生气'],
    request: { relationshipGoal: '修复冲突' },
    allowed: ['承接', '降压', '澄清']
  },
  {
    id: 'invitation',
    text: ['周末有空吗', '还不知道，这周有点忙'],
    request: { relationshipGoal: '主动邀约' },
    allowed: ['降压', '承接', '澄清', '收线']
  },
  {
    id: 'stop-contact',
    text: ['请不要再联系我', '我再解释一下'],
    request: {},
    allowed: ['收线'],
    blocked: true
  },
  {
    id: 'reported-boundary',
    text: ['他说“不要再联系我”，我有点难受'],
    request: {},
    allowed: ['承接', '澄清', '降压'],
    blocked: false
  }
]

const reports: Array<{
  scenario: string
  variant: string
  sample: number
  elapsedMs: number
  result: ReplyAssistantResult
}> = []
let provider: AIProviderService

beforeAll(() => {
  const baseUrl = process.env.REPLY_EVAL_BASE_URL
  const model = process.env.REPLY_EVAL_MODEL
  if (!baseUrl || !model) {
    throw new Error(
      '真实评估需要 REPLY_EVAL_BASE_URL 与 REPLY_EVAL_MODEL；认证端点另设 REPLY_EVAL_API_KEY。不会读取日常账户配置。'
    )
  }
  provider = new AIProviderService()
  const saved = provider.save({
    id: 'reply-eval',
    name: '回复效果评估',
    type: 'openai-compatible',
    baseUrl,
    apiKey: process.env.REPLY_EVAL_API_KEY,
    auth: { type: process.env.REPLY_EVAL_API_KEY ? 'bearer' : 'none' },
    models: [
      {
        id: model,
        name: model,
        capabilities: { chat: true, vision: false, ocr: false, longContext: false }
      }
    ],
    defaultModel: model,
    advanced: { timeoutMs: 45_000, extraHeaders: {}, maxTokens: 1500 }
  })
  expect(saved.success).toBe(true)
})

afterAll(() => {
  try {
    if (reports.length) {
      const output = resolve(
        process.env.REPLY_EVAL_OUTPUT || 'output/reply-evaluation/results.json'
      )
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(
        output,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            model: process.env.REPLY_EVAL_MODEL,
            note: '仅使用合成场景。自动断言不代表自然度与实际采纳效果；需结合 blind-review.md 人工盲评。',
            reports
          },
          null,
          2
        )
      )
      const blind = reports
        .map((report, index) =>
          [
            `## 样本 ${index + 1} / ${report.scenario}`,
            ...report.result.candidates.map((candidate) => `- ${candidate}`),
            '事实一致：__ / 口吻自然：__ / 目标一致：__ / 可执行：__',
            ''
          ].join('\n')
        )
        .join('\n')
      writeFileSync(join(dirname(output), 'blind-review.md'), `# 回复盲评\n\n${blind}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const scenario of scenarios) {
  test(`真实模型：${scenario.id}`, async () => {
    const samples = Math.min(3, Math.max(1, Number(process.env.REPLY_EVAL_SAMPLES) || 1))
    for (let sample = 0; sample < samples; sample += 1) {
      // 交替执行顺序，盲评文件不写变体名称；明细 JSON 保留可复现信息。
      const variants = sample % 2 ? ['knowledge', 'baseline'] : ['baseline', 'knowledge']
      for (const variant of variants) {
        const service = new ReplyAssistantService({
          platform: 'win32',
          ai: provider,
          knowledge:
            variant === 'knowledge'
              ? new ReplyAssistantKnowledgeService(resolve('resources/reply-assistant'))
              : undefined,
          loadMessages: async () =>
            scenario.text.map((content, index) => ({
              id: `${scenario.id}-${index}`,
              content,
              isSender:
                scenario.text.length === 2 &&
                (scenario.id === 'stop-contact' ? index === 1 : index === 0),
              createTime: 1_794_096_000 + index * 60
            }))
        })
        const started = Date.now()
        const result = await service.analyze({
          userMd5: `eval-${scenario.id}`,
          ...scenario.request,
          rankCandidates: process.env.REPLY_EVAL_RANK !== 'false'
        })
        reports.push({
          scenario: scenario.id,
          variant,
          sample,
          elapsedMs: Date.now() - started,
          result
        })
        expect.soft(result.success, `${scenario.id}/${variant}: ${result.error || ''}`).toBe(true)
        expect.soft(result.blocked).toBe(scenario.blocked ?? false)
        expect.soft(scenario.allowed).toContain(result.strategy?.strategy)
        if (scenario.blocked) expect.soft(result.candidates).toHaveLength(0)
        else expect.soft(result.candidates.length).toBeGreaterThan(0)
        expect
          .soft(
            result.strategy?.evidence?.every((evidence) =>
              result.sourceMessageIds.includes(evidence.messageId)
            )
          )
          .toBe(true)
      }
    }
  })
}

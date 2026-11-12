import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { ANALYSIS_SYSTEM_PROMPT, RANK_SYSTEM_PROMPT } from '../../src/shared/reply-assistant'

const root = mkdtempSync(join(tmpdir(), 'reply-provider-flow-'))
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

afterAll(() => rmSync(root, { recursive: true, force: true }))

it('通过真实 HTTP、Provider、磁盘资料与评估程序完成完整链路', async () => {
  const calls: Array<{ url?: string; model: string; messages: Array<{ content: string }> }> = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    calls.push({ url: request.url, ...payload })
    const system = payload.messages[0].content as string
    const context = JSON.parse(payload.messages[1].content)
    const latest = context.transcript.at(-1)
    const content = system.startsWith(ANALYSIS_SYSTEM_PROMPT)
      ? JSON.stringify({
          strategy: '澄清',
          confidence: null,
          intent: '确认有空的时间',
          evidence: [{ messageId: latest.id, quote: latest.text }],
          facts: [],
          unknowns: ['具体日期未知'],
          nextStep: '先问一个可用时间',
          stopCondition: '对方不想约时停止'
        })
      : system.startsWith(RANK_SYSTEM_PROMPT)
        ? '{"scores":[{"id":0,"score":80},{"id":1,"score":60},{"id":2,"score":40}]}'
        : '["你哪天方便","时间定了告诉我","等你确定了再约"]'
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
      })
    )
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server port')
    const provider = new AIProviderService()
    expect(
      provider.save({
        id: 'reply-http',
        name: '本地测试端点',
        type: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        auth: { type: 'none' },
        models: [
          {
            id: 'fixture-model',
            name: 'Fixture',
            capabilities: { chat: true, vision: false, ocr: false, longContext: false }
          }
        ],
        defaultModel: 'fixture-model',
        advanced: { timeoutMs: 3000, extraHeaders: {} }
      }).success
    ).toBe(true)
    const service = new ReplyAssistantService({
      platform: 'win32',
      ai: provider,
      knowledge: new ReplyAssistantKnowledgeService(resolve('resources/reply-assistant')),
      loadMessages: async () => [
        { id: 'a', content: '时间还没定', isSender: false, createTime: 1_794_096_000 }
      ]
    })
    const result = await service.analyze({
      userMd5: 'synthetic-contact',
      relationshipGoal: '主动邀约'
    })
    expect(result.success, result.error).toBe(true)
    expect(result.usage).toMatchObject({ calls: 3, input: 300, output: 150, total: 450 })
    expect(result.strategy?.evidence?.[0]).toMatchObject({ messageId: 'a', quote: '时间还没定' })
    expect(result.knowledge?.sources.map((source) => source.id)).toContain('invitation')
    expect(calls).toHaveLength(3)
    expect(calls.every((call) => call.url === '/v1/chat/completions')).toBe(true)
    expect(calls.every((call) => call.model === 'fixture-model')).toBe(true)
    expect(result.brief.nextStep).toBe('先问一个可用时间')

    // 用确定性本地端点验证评估程序本身；这不是外部真实模型的质量结论。
    const output = join(root, 'evaluation/results.json')
    const execution = await new Promise<{ code: number | null; output: string }>((resolveRun) => {
      const child = spawn(
        process.execPath,
        [
          resolve('node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          resolve('vitest.reply-eval.config.ts')
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            REPLY_EVAL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            REPLY_EVAL_MODEL: 'fixture-model',
            REPLY_EVAL_API_KEY: '',
            REPLY_EVAL_SAMPLES: '1',
            REPLY_EVAL_RANK: 'true',
            REPLY_EVAL_OUTPUT: output
          },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      let captured = ''
      child.stdout.on('data', (chunk) => {
        captured += chunk
      })
      child.stderr.on('data', (chunk) => {
        captured += chunk
      })
      child.once('error', (error) => resolveRun({ code: -1, output: error.message }))
      child.once('close', (code) => resolveRun({ code, output: captured }))
    })
    expect(execution.code, execution.output).toBe(0)
    const report = JSON.parse(readFileSync(output, 'utf8'))
    expect(report.reports).toHaveLength(12)
    expect(new Set(report.reports.map((row: { variant: string }) => row.variant))).toEqual(
      new Set(['baseline', 'knowledge'])
    )
    expect(readFileSync(join(root, 'evaluation/blind-review.md'), 'utf8')).toContain('口吻自然')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose()))
    )
  }
}, 30_000)

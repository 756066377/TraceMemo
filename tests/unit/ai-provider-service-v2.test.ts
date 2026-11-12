import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { AIProviderConfig } from '../../src/shared/ai-provider'

const root = mkdtempSync(join(tmpdir(), 'tracememo-ai-provider-v2-'))

vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { AIProviderService } from '../../src/main/services/ai-provider-service'

function provider(overrides: Partial<AIProviderConfig> = {}): AIProviderConfig {
  return {
    id: 'relay-test',
    name: '我的中转站',
    type: 'openai-compatible',
    baseUrl: 'https://one2api.xyz/v1',
    auth: { type: 'none' },
    models: [
      {
        id: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        capabilities: { chat: true, vision: true, ocr: true, longContext: true }
      }
    ],
    defaultModel: 'gpt-5.6-terra',
    advanced: { timeoutMs: 5000, extraHeaders: {} },
    ...overrides
  }
}

describe('AI 供应商服务 v2', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('中转站上的未注册模型可以正常保存（不再按分组拒绝）', () => {
    const service = new AIProviderService()
    const result = service.save(provider())
    expect(result.success).toBe(true)
    const saved = result.providers.find((item) => item.id === 'relay-test')
    expect(saved?.models.map((model) => model.id)).toEqual(['gpt-5.6-terra'])
    expect(saved?.templateId).toBe('custom')
  })

  it('Base URL 末尾的接口路径会被裁掉，并给出 notice', () => {
    const service = new AIProviderService()
    const result = service.save(
      provider({ id: 'trim-test', baseUrl: 'https://one2api.xyz/v1/chat/completions' })
    )
    expect(result.success).toBe(true)
    expect(result.providers[0].baseUrl).toBe('https://one2api.xyz/v1')
    expect(result.notices?.join()).toContain('接口路径')
  })

  it('默认模型不在列表时改成第一个模型', () => {
    const service = new AIProviderService()
    const result = service.save(provider({ id: 'default-test', defaultModel: 'ghost' }))
    expect(result.success).toBe(true)
    expect(result.providers[0].defaultModel).toBe('gpt-5.6-terra')
  })

  it('按模型名路由到声明它的供应商，而不是默认供应商', async () => {
    const service = new AIProviderService()
    service.save(
      provider({
        id: 'relay-a',
        name: 'A',
        models: [
          {
            id: 'model-a',
            name: 'Model A',
            capabilities: { chat: true, vision: false, ocr: false, longContext: false }
          }
        ],
        defaultModel: 'model-a'
      })
    )
    service.save(
      provider({
        id: 'relay-b',
        name: 'B',
        baseUrl: 'https://second.example.test/v1',
        models: [
          {
            id: 'model-b',
            name: 'Model B',
            capabilities: { chat: true, vision: false, ocr: false, longContext: false }
          }
        ],
        defaultModel: 'model-b'
      })
    )
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url))
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })
    )
    try {
      const result = await service.chat([{ role: 'user', content: 'hi' }], {
        modelId: 'model-b'
      })
      expect(result.success).toBe(true)
      expect(calls[0]).toBe('https://second.example.test/v1/chat/completions')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('显式指定错供应商时给出可定位的报错', async () => {
    const service = new AIProviderService()
    service.save(provider({ id: 'relay-a', name: 'A' }))
    const result = await service.chat([{ role: 'user', content: 'hi' }], {
      providerId: 'relay-a',
      modelId: 'not-here'
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('relay-a')
    expect(result.error).toContain('not-here')
  })

  it('探测模型：解析 /models 的 data[].id', async () => {
    const service = new AIProviderService()
    service.save(provider({ id: 'probe-test' }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: 'gpt-5.6-terra', owned_by: 'openai' },
              { id: 'deepseek-chat', owned_by: 'deepseek' },
              { id: 'gpt-5.6-terra' }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    )
    try {
      const result = await service.probeModels({ providerId: 'probe-test' })
      expect(result.success).toBe(true)
      expect(result.models.map((model) => model.id)).toEqual(['gpt-5.6-terra', 'deepseek-chat'])
      expect(result.models[0].ownedBy).toBe('openai')
      expect(result.endpoint).toBe('https://one2api.xyz/v1/models')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('连接测试：上游「分组无可用渠道」被翻译成模型问题 + 处理建议', async () => {
    const service = new AIProviderService()
    service.save(provider({ id: 'channel-test' }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message:
                'Model "gpt-5.6-terra" is not supported by any configured account in this group',
              type: 'invalid_request_error'
            }
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      )
    )
    try {
      const result = await service.test('channel-test')
      expect(result.success).toBe(false)
      expect(result.diagnosis?.code).toBe('MODEL_NOT_FOUND')
      expect(result.diagnosis?.upstreamMessage).toContain('not supported by any configured account')
      expect(result.diagnosis?.hint).toContain('分组')
      const saved = service.list().providers.find((item) => item.id === 'channel-test')
      expect(saved?.status).toBe('error')
      expect(saved?.lastDiagnosis?.code).toBe('MODEL_NOT_FOUND')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('连接测试：Responses 404 时自动回退到 Chat Completions', async () => {
    const service = new AIProviderService()
    service.save(
      provider({
        id: 'fallback-test',
        advanced: { timeoutMs: 5000, extraHeaders: {}, apiProtocol: 'responses' }
      })
    )
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url))
        if (String(url).endsWith('/responses')) {
          return new Response(JSON.stringify({ error: { message: 'not found' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })
    )
    try {
      const result = await service.test('fallback-test')
      expect(result.success).toBe(true)
      expect(result.diagnosis?.protocol).toBe('chat-completions')
      expect(urls.some((url) => url.endsWith('/responses'))).toBe(true)
      expect(urls.some((url) => url.endsWith('/chat/completions'))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('保存后端点变化会把连接状态重置为未测试', () => {
    const service = new AIProviderService()
    service.save(provider({ id: 'reset-test' }))
    const before = service.list().providers.find((item) => item.id === 'reset-test')
    expect(before?.status).toBe('untested')
    service.save(provider({ id: 'reset-test', baseUrl: 'https://other.example.test/v1' }))
    const after = service.list().providers.find((item) => item.id === 'reset-test')
    expect(after?.status).toBe('untested')
    expect(after?.baseUrl).toBe('https://other.example.test/v1')
  })
})

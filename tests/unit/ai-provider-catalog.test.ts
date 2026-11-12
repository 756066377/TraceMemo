import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDER_TEMPLATES,
  createModelDefinition,
  createProviderDraft,
  getProviderTemplate,
  humanizeModelId,
  matchProviderTemplateFromBaseUrl,
  resolveTemplateId,
  uniqueModels
} from '../../src/shared/ai-provider-catalog'

describe('供应商模板目录', () => {
  it('每个模板都有唯一 ID 与可用的基础字段', () => {
    const ids = AI_PROVIDER_TEMPLATES.map((template) => template.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const template of AI_PROVIDER_TEMPLATES) {
      expect(template.label.length).toBeGreaterThan(0)
      expect(['chat-completions', 'responses']).toContain(template.protocol)
    }
  })

  it('按 Base URL 匹配官方端点，未知主机返回 undefined 而不是强行归类', () => {
    expect(matchProviderTemplateFromBaseUrl('https://api.openai.com/v1')?.id).toBe('openai')
    expect(matchProviderTemplateFromBaseUrl('https://api.deepseek.com/v1')?.id).toBe('deepseek')
    expect(matchProviderTemplateFromBaseUrl('https://one2api.xyz/v1')).toBeUndefined()
  })

  it('中转站草稿不带默认模型，要求先探测端点', () => {
    const draft = createProviderDraft('relay')
    expect(draft.templateId).toBe('relay')
    expect(draft.baseUrl).toBe('')
    expect(draft.models).toEqual([])
    expect(draft.advanced.apiProtocol).toBe('chat-completions')
    // 生成后需要用户自己填模型，不允许悄悄塞一个官方模型名
    expect(draft.defaultModel).toBe('')
  })

  it('已知模型名自动带能力，未知模型名按纯聊天处理', () => {
    expect(createModelDefinition('gpt-5.6-terra').capabilities.vision).toBe(true)
    expect(createModelDefinition('claude-sonnet-4-5').capabilities.longContext).toBe(true)
    const unknown = createModelDefinition('my-relay-model-01')
    expect(unknown.capabilities).toEqual({
      chat: true,
      vision: false,
      ocr: false,
      longContext: false
    })
    expect(unknown.name).toBe('My Relay Model 01')
  })

  it('重复模型按大小写去重，并保留第一次出现的定义', () => {
    const models = uniqueModels([
      createModelDefinition('gpt-4o-mini'),
      createModelDefinition('GPT-4O-MINI'),
      createModelDefinition('deepseek-chat')
    ])
    expect(models.map((model) => model.id)).toEqual(['gpt-4o-mini', 'deepseek-chat'])
  })

  it('老配置没有 templateId 时按地址推导，未知地址落到 custom', () => {
    expect(
      resolveTemplateId({
        baseUrl: 'https://api.openai.com/v1',
        models: [createModelDefinition('gpt-4o-mini')]
      })
    ).toBe('openai')
    expect(resolveTemplateId({ baseUrl: 'https://relay.example.test/v1', models: [] })).toBe(
      'custom'
    )
  })

  it('模板查询与模型显示名', () => {
    expect(getProviderTemplate('anthropic')?.type).toBe('anthropic-messages')
    expect(getProviderTemplate('not-exist')).toBeUndefined()
    expect(humanizeModelId('deepseek-reasoner')).toBe('DeepSeek Reasoner')
    expect(humanizeModelId('qwen2.5-72b')).toBe('Qwen2.5 72b')
  })
})

import { describe, expect, it } from 'vitest'
import type { AIProviderConfig } from '../../src/shared/ai-provider'
import {
  adviseProviderSetup,
  describeAIProviderAdvisor
} from '../../src/shared/ai-provider-advisor'
import { createModelDefinition, createProviderDraft } from '../../src/shared/ai-provider-catalog'

const relayDraft = (): AIProviderConfig => {
  const draft = createProviderDraft('relay')
  draft.name = '我的中转站'
  draft.baseUrl = 'https://one2api.xyz/v1'
  draft.apiKey = 'sk-test'
  draft.models = [createModelDefinition('gpt-5.6-terra')]
  draft.defaultModel = 'gpt-5.6-terra'
  return draft
}

describe('TypeSafe 供应商安装策略', () => {
  it('只声明职责与边界，不声称能写入或联网', () => {
    const info = describeAIProviderAdvisor()
    expect(info.strategy).toBe('typesafe-provider-install-v2')
    expect(info.boundary).toContain('不发起网络请求')
    expect(info.boundary).toContain('不阻止保存')
  })

  it('中转站 + 已知模型名：不产生阻断性建议', () => {
    const report = adviseProviderSetup({ ...relayDraft(), hasApiKey: true })
    expect(report.advices.filter((advice) => advice.level === 'warning')).toEqual([])
    expect(report.shouldProbeModels).toBe(false)
    expect(report.knownModels).toEqual(['gpt-5.6-terra'])
    expect(report.host).toBe('one2api.xyz')
  })

  it('未知模型名会要求先探测端点，但不阻止保存', () => {
    const draft = relayDraft()
    draft.models = [createModelDefinition('relay-ultra-9')]
    draft.defaultModel = 'relay-ultra-9'
    const report = adviseProviderSetup({ ...draft, hasApiKey: true })
    expect(report.unknownModels).toEqual(['relay-ultra-9'])
    expect(report.shouldProbeModels).toBe(true)
    expect(report.advices.some((advice) => advice.message.includes('测试连接'))).toBe(true)
  })

  it('Base URL 填到具体接口时提示会被裁剪', () => {
    const draft = relayDraft()
    draft.baseUrl = 'https://one2api.xyz/v1/chat/completions'
    const report = adviseProviderSetup({ ...draft, hasApiKey: true })
    expect(report.advices.some((advice) => advice.message.includes('/chat/completions'))).toBe(true)
  })

  it('Responses 协议配在非官方 host 上给出警告', () => {
    const draft = relayDraft()
    draft.advanced = { ...draft.advanced, apiProtocol: 'responses' }
    const report = adviseProviderSetup({ ...draft, hasApiKey: true })
    expect(report.protocol).toBe('responses')
    expect(
      report.advices.some((advice) => advice.field === 'protocol' && advice.level === 'warning')
    ).toBe(true)
  })

  it('缺 Key、缺模型、默认模型不在列表都会提示', () => {
    const draft = createProviderDraft('relay')
    draft.baseUrl = 'https://relay.example.test/v1'
    draft.defaultModel = 'ghost-model'
    draft.models = [createModelDefinition('real-model')]
    const report = adviseProviderSetup({ ...draft, hasApiKey: false })
    const messages = report.advices.map((advice) => advice.message).join('\n')
    expect(messages).toContain('API Key')
    expect(messages).toContain('默认模型不在模型列表里')
  })

  it('模板与地址不一致时只给提示，不改写配置', () => {
    const draft = relayDraft()
    draft.templateId = 'openai'
    const report = adviseProviderSetup({ ...draft, hasApiKey: true })
    expect(report.templateId).toBe('openai')
    expect(
      report.advices.some((advice) => advice.field === 'template' && advice.level === 'info')
    ).toBe(true)
  })
})

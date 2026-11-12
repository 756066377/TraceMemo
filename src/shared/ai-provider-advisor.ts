/**
 * TypeSafe 供应商安装策略。
 *
 * 职责：只看表单里的静态信息，判断「这套配置装上去大概会发生什么」，输出可读建议。
 * 边界：不读密钥、不联网、不写配置、**不阻断保存**。
 *       上一个版本把「模型必须归属到分组账户」做成了硬校验，结果中转站上的新模型
 *       一律被拒绝保存；这里改为建议，能否使用由真实请求结果决定。
 */

import type { AIProviderConfig, AIProviderType, AIOpenAIProtocol } from './ai-provider'
import {
  getProviderTemplate,
  knownModelCapabilities,
  matchProviderTemplateFromBaseUrl,
  providerHost,
  resolveTemplateId
} from './ai-provider-catalog'

export const TYPESAFE_ADVISOR_ID = 'typesafe-provider-install-v2'

export type AIProviderAdviceLevel = 'info' | 'warning'

export interface AIProviderAdvice {
  level: AIProviderAdviceLevel
  field: 'baseUrl' | 'apiKey' | 'models' | 'protocol' | 'type' | 'template'
  message: string
}

export interface AIProviderAdvisorReport {
  strategy: typeof TYPESAFE_ADVISOR_ID
  templateId: string
  templateLabel: string
  host: string
  protocol: AIOpenAIProtocol | 'anthropic-messages'
  requiresKey: boolean
  knownModels: string[]
  unknownModels: string[]
  /** 建议调用 /models 探测：模型名无法从已知族确认时置为 true。 */
  shouldProbeModels: boolean
  advices: AIProviderAdvice[]
}

export interface AIProviderAdvisorInfo {
  strategy: typeof TYPESAFE_ADVISOR_ID
  responsibility: string
  boundary: string
  inputs: string[]
  outputs: string[]
}

export function describeAIProviderAdvisor(): AIProviderAdvisorInfo {
  return {
    strategy: TYPESAFE_ADVISOR_ID,
    responsibility:
      '根据 Base URL、协议、认证与模型列表给出安装前建议，并把「未知模型」标记为需要端点探测。',
    boundary: '只做静态判断：不读取密钥、不发起网络请求、不写入配置、不阻止保存。',
    inputs: ['baseUrl', 'type', 'apiProtocol', 'auth', 'models', 'templateId', 'hasApiKey'],
    outputs: ['advices', 'unknownModels', 'shouldProbeModels', 'protocol']
  }
}

function protocolOf(
  provider: Pick<AIProviderConfig, 'type' | 'advanced'>
): AIOpenAIProtocol | 'anthropic-messages' {
  if (provider.type === 'anthropic-messages') return 'anthropic-messages'
  return provider.advanced?.apiProtocol === 'responses' ? 'responses' : 'chat-completions'
}

function looksLikeFullEndpoint(baseUrl: string): boolean {
  return /\/(?:chat\/completions|responses|completions)\/?$/i.test(baseUrl.trim())
}

export function adviseProviderSetup(
  provider: Pick<
    AIProviderConfig,
    'id' | 'name' | 'type' | 'baseUrl' | 'auth' | 'models' | 'defaultModel' | 'advanced'
  > & { templateId?: string; hasApiKey?: boolean }
): AIProviderAdvisorReport {
  const advices: AIProviderAdvice[] = []
  const templateId = resolveTemplateId({
    templateId: provider.templateId,
    baseUrl: provider.baseUrl,
    models: provider.models
  })
  const template = getProviderTemplate(templateId)
  const host = providerHost(provider.baseUrl)
  const protocol = protocolOf(provider)
  const requiresKey = template?.requiresKey !== false && provider.type !== 'ollama'

  const baseUrl = provider.baseUrl.trim()
  if (!baseUrl) {
    advices.push({
      level: 'warning',
      field: 'baseUrl',
      message: '还没有填 Base URL。中转站请填它给你的 /v1 地址，不要带 /chat/completions。'
    })
  } else if (!/^https?:\/\//i.test(baseUrl)) {
    advices.push({
      level: 'warning',
      field: 'baseUrl',
      message: 'Base URL 需要以 http:// 或 https:// 开头。'
    })
  } else if (looksLikeFullEndpoint(baseUrl)) {
    advices.push({
      level: 'warning',
      field: 'baseUrl',
      message: 'Base URL 填到了具体接口路径，保存时会自动去掉 /chat/completions 或 /responses。'
    })
  }

  if (template?.baseUrl && host && providerHost(template.baseUrl) !== host) {
    advices.push({
      level: 'info',
      field: 'template',
      message: `模板是「${template.label}」，但地址指向 ${host}；将按自定义端点处理，模型名以端点实际提供的为准。`
    })
  }

  if (protocol === 'responses' && host && host !== 'api.openai.com') {
    advices.push({
      level: 'warning',
      field: 'protocol',
      message:
        'Responses API 只有 OpenAI 官方与少数兼容网关支持。多数中转站只实现 Chat Completions，连不上就切回 Chat Completions。'
    })
  }

  if (requiresKey && provider.hasApiKey === false) {
    advices.push({
      level: 'warning',
      field: 'apiKey',
      message: '这个供应商需要 API Key，当前还没有填写。'
    })
  }

  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const model of provider.models) {
    const key = model.id.trim().toLowerCase()
    if (!key) continue
    if (seen.has(key)) duplicates.add(model.id.trim())
    seen.add(key)
  }
  if (duplicates.size) {
    advices.push({
      level: 'info',
      field: 'models',
      message: `重复的模型会合并：${[...duplicates].join('、')}。`
    })
  }

  if (!provider.models.some((model) => model.id.trim())) {
    advices.push({
      level: 'warning',
      field: 'models',
      message: '还没有模型。可以先点「探测模型」从端点读取，或手动填模型 ID。'
    })
  }

  const knownModels: string[] = []
  const unknownModels: string[] = []
  for (const model of provider.models) {
    const id = model.id.trim()
    if (!id) continue
    if (knownModelCapabilities(id)) knownModels.push(id)
    else unknownModels.push(id)
  }
  if (unknownModels.length) {
    advices.push({
      level: 'info',
      field: 'models',
      message: `无法从模型名判断能力：${unknownModels.join('、')}。保存后用「测试连接」确认端点确实提供这些模型。`
    })
  }

  if (
    provider.defaultModel &&
    !provider.models.some((model) => model.id.trim() === provider.defaultModel.trim())
  ) {
    advices.push({
      level: 'warning',
      field: 'models',
      message: '默认模型不在模型列表里，保存时会自动改成第一个模型。'
    })
  }

  const explicitTemplate = provider.templateId
    ? getProviderTemplate(provider.templateId)
    : undefined
  const hostTemplate = matchProviderTemplateFromBaseUrl(provider.baseUrl)
  if (explicitTemplate && hostTemplate && explicitTemplate.id !== hostTemplate.id) {
    advices.push({
      level: 'info',
      field: 'template',
      message: `地址更像「${hostTemplate.label}」，当前模板是「${explicitTemplate.label}」；仅影响默认值，不影响保存。`
    })
  }

  return {
    strategy: TYPESAFE_ADVISOR_ID,
    templateId,
    templateLabel: template?.label || '自定义端点',
    host,
    protocol,
    requiresKey,
    knownModels,
    unknownModels,
    shouldProbeModels: unknownModels.length > 0,
    advices
  }
}

/** 判断某个供应商类型是否支持 /models 探测。 */
export function supportsModelProbe(type: AIProviderType): boolean {
  return type !== 'anthropic-messages'
}

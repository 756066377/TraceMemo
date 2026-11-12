/**
 * 供应商模板目录。
 *
 * 参考 goutou `core/providers.py` 的供应商表与 CC Switch 的预设供应商列表：
 * 模板只负责「填好默认值」，不参与模型归属判断。用户把 Base URL 换成中转站时，
 * 模板匹配失败也照样能保存，只是名称与协议需要自己确认。
 */

import type {
  AIModelCapabilities,
  AIModelDefinition,
  AIProviderConfig,
  AIProviderType,
  AIOpenAIProtocol
} from './ai-provider'

export type AIProviderVendor = '官方' | '国内' | '聚合中转' | '本地' | '自定义'

export interface AIProviderTemplate {
  id: string
  label: string
  vendor: AIProviderVendor
  type: AIProviderType
  baseUrl: string
  /** anthropic-messages 类型不使用该字段。 */
  protocol: AIOpenAIProtocol
  models: string[]
  requiresKey: boolean
  docs?: string
  note?: string
}

export const AI_PROVIDER_TEMPLATES: AIProviderTemplate[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    vendor: '官方',
    type: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'chat-completions',
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'o4-mini'],
    requiresKey: true,
    docs: 'https://platform.openai.com/api-keys',
    note: '官方 Chat Completions 接口；GPT-5 及以上也可切到 Responses API。'
  },
  {
    id: 'openai-responses',
    label: 'OpenAI (Responses API)',
    vendor: '官方',
    type: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'responses',
    models: ['gpt-5', 'gpt-5-mini'],
    requiresKey: true,
    docs: 'https://platform.openai.com/docs/api-reference/responses',
    note: '只支持 /responses 的端点用这个模板；多数中转站不支持。'
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    vendor: '官方',
    type: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com/v1',
    protocol: 'chat-completions',
    models: ['claude-sonnet-4-5', 'claude-3-5-haiku-latest'],
    requiresKey: true,
    docs: 'https://console.anthropic.com/settings/keys',
    note: 'Messages API，认证头为 x-api-key。'
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    vendor: '官方',
    type: 'azure-openai',
    baseUrl: 'https://example.openai.azure.com/openai/v1',
    protocol: 'chat-completions',
    models: [],
    requiresKey: true,
    note: '模型 ID 填部署名；Base URL 换成自己的资源域名。'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    vendor: '国内',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'chat-completions',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    requiresKey: true,
    docs: 'https://platform.deepseek.com/api_keys'
  },
  {
    id: 'qwen',
    label: '通义千问 (DashScope)',
    vendor: '国内',
    type: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'chat-completions',
    models: ['qwen-plus', 'qwen-max', 'qwen-vl-max'],
    requiresKey: true,
    docs: 'https://bailian.console.aliyun.com/'
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    vendor: '国内',
    type: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'chat-completions',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
    requiresKey: true,
    docs: 'https://platform.moonshot.cn/console/api-keys'
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    vendor: '国内',
    type: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'chat-completions',
    models: ['glm-4-plus', 'glm-4v-plus'],
    requiresKey: true,
    docs: 'https://open.bigmodel.cn/usercenter/apikeys'
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    vendor: '国内',
    type: 'openai-compatible',
    baseUrl: 'https://api.minimax.chat/v1',
    protocol: 'chat-completions',
    models: ['MiniMax-Text-01'],
    requiresKey: true
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    vendor: '国内',
    type: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    protocol: 'chat-completions',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
    requiresKey: true,
    docs: 'https://cloud.siliconflow.cn/account/ak'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    vendor: '聚合中转',
    type: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'chat-completions',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'],
    requiresKey: true,
    docs: 'https://openrouter.ai/keys',
    note: '模型 ID 带供应商前缀，例如 openai/gpt-4o-mini。'
  },
  {
    id: 'ollama',
    label: 'Ollama (本地)',
    vendor: '本地',
    type: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'chat-completions',
    models: ['qwen2.5', 'llama3.2'],
    requiresKey: false,
    docs: 'https://ollama.com/library',
    note: '无需 API Key；模型名填 ollama list 里的名字。'
  },
  {
    id: 'relay',
    label: '中转站 / 聚合 API',
    vendor: '聚合中转',
    type: 'openai-compatible',
    baseUrl: '',
    protocol: 'chat-completions',
    models: [],
    requiresKey: true,
    note: 'Base URL 填中转站给的 /v1 地址；模型名用「探测模型」按钮从端点读取，不要照抄别家的模型名。'
  },
  {
    id: 'custom',
    label: '自定义端点',
    vendor: '自定义',
    type: 'openai-compatible',
    baseUrl: '',
    protocol: 'chat-completions',
    models: [],
    requiresKey: true,
    note: '任何 OpenAI 兼容端点。'
  }
]

const TEMPLATE_INDEX = new Map(AI_PROVIDER_TEMPLATES.map((template) => [template.id, template]))

export function getProviderTemplate(id?: string): AIProviderTemplate | undefined {
  return id ? TEMPLATE_INDEX.get(id) : undefined
}

export function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

function hostOf(template: AIProviderTemplate): string {
  return template.baseUrl ? providerHost(template.baseUrl) : ''
}

/** 按 Base URL 找模板；只用于回填默认值，找不到就返回 undefined，不强行归类。 */
export function matchProviderTemplateFromBaseUrl(baseUrl: string): AIProviderTemplate | undefined {
  const host = providerHost(baseUrl)
  if (!host) return undefined
  return AI_PROVIDER_TEMPLATES.find((template) => {
    const known = hostOf(template)
    return Boolean(known) && (host === known || host.endsWith(`.${known}`))
  })
}

export function matchProviderTemplateFromModels(
  modelIds: string[]
): AIProviderTemplate | undefined {
  const ids = modelIds.map((id) => id.trim().toLowerCase()).filter(Boolean)
  if (!ids.length) return undefined
  let best: AIProviderTemplate | undefined
  let bestScore = 0
  for (const template of AI_PROVIDER_TEMPLATES) {
    const score = template.models.filter((model) => ids.includes(model.trim().toLowerCase())).length
    if (score > bestScore) {
      best = template
      bestScore = score
    }
  }
  return best
}

/** 新配置写入 templateId；老配置没有该字段时按 Base URL / 模型列表推导，仅用于展示。 */
export function resolveTemplateId(
  config: Pick<AIProviderConfig, 'templateId' | 'baseUrl' | 'models'>
): string {
  if (config.templateId && TEMPLATE_INDEX.has(config.templateId)) return config.templateId
  const byHost = matchProviderTemplateFromBaseUrl(config.baseUrl)
  if (byHost) return byHost.id
  const byModels = matchProviderTemplateFromModels(config.models.map((model) => model.id))
  return byModels?.id || 'custom'
}

export function defaultAuthForTemplate(template: AIProviderTemplate): AIProviderConfig['auth'] {
  if (template.type === 'ollama' || !template.requiresKey) return { type: 'none' }
  if (template.type === 'anthropic-messages') return { type: 'x-api-key' }
  return { type: 'bearer' }
}

export function createProviderId(templateId: string, seed = Date.now().toString(36)): string {
  return `${templateId}-${seed}`
}

export function createProviderDraft(
  templateId = 'relay',
  options: { modelIds?: string[]; idSeed?: string } = {}
): AIProviderConfig {
  const template = getProviderTemplate(templateId) || TEMPLATE_INDEX.get('custom')!
  const id = createProviderId(template.id, options.idSeed)
  const modelIds = (options.modelIds?.length ? options.modelIds : template.models).filter(Boolean)
  return {
    id,
    name: template.label,
    type: template.type,
    baseUrl: template.baseUrl,
    apiKey: '',
    auth: defaultAuthForTemplate(template),
    models: modelIds.map((modelId) => createModelDefinition(modelId, { detected: false })),
    defaultModel: modelIds[0] || '',
    advanced: {
      timeoutMs: 120_000,
      temperature: 0.7,
      maxTokens: 4096,
      stream: false,
      apiProtocol: template.protocol,
      thinking: 'default',
      extraHeaders: {}
    },
    templateId: template.id,
    role: 'chat'
  }
}

const CHAT_ONLY: AIModelCapabilities = {
  chat: true,
  vision: false,
  ocr: false,
  longContext: false
}
const CHAT_LONG: AIModelCapabilities = {
  chat: true,
  vision: false,
  ocr: false,
  longContext: true
}
const CHAT_VISION: AIModelCapabilities = {
  chat: true,
  vision: true,
  ocr: true,
  longContext: true
}

interface ModelProfile {
  pattern: RegExp
  label?: (modelId: string) => string
  capabilities: AIModelCapabilities
  maxTokens?: number
}

const MODEL_PROFILES: ModelProfile[] = [
  { pattern: /^gpt-5\.6(?:-|$)/i, capabilities: CHAT_VISION, maxTokens: 128_000 },
  { pattern: /^gpt-6(?:-|$)/i, capabilities: CHAT_VISION, maxTokens: 200_000 },
  { pattern: /^gpt-(?:4o|4\.1|4-turbo)/i, capabilities: CHAT_VISION, maxTokens: 128_000 },
  { pattern: /^gpt-5(?:-|$)/i, capabilities: CHAT_VISION, maxTokens: 128_000 },
  { pattern: /^o[1345](?:-|$)/i, capabilities: CHAT_LONG, maxTokens: 128_000 },
  { pattern: /^claude-/i, capabilities: CHAT_VISION, maxTokens: 200_000 },
  { pattern: /^gemini-/i, capabilities: CHAT_VISION, maxTokens: 200_000 },
  { pattern: /^grok-/i, capabilities: CHAT_VISION, maxTokens: 128_000 },
  { pattern: /^deepseek-/i, capabilities: CHAT_LONG, maxTokens: 128_000 },
  { pattern: /^qwen.*vl/i, capabilities: CHAT_VISION, maxTokens: 128_000 },
  { pattern: /^qwen/i, capabilities: CHAT_LONG, maxTokens: 128_000 },
  { pattern: /^qwq/i, capabilities: CHAT_LONG },
  { pattern: /^glm-4v/i, capabilities: CHAT_VISION, maxTokens: 64_000 },
  { pattern: /^glm-/i, capabilities: CHAT_LONG, maxTokens: 128_000 },
  { pattern: /^moonshot-|^kimi/i, capabilities: CHAT_LONG, maxTokens: 128_000 },
  { pattern: /^minimax-|^abab/i, capabilities: CHAT_LONG },
  { pattern: /^llama|^mistral|^mixtral/i, capabilities: CHAT_LONG }
]

/** 已知模型族只用于「建议能力」，不是准入条件。 */
export function knownModelCapabilities(modelId: string): AIModelCapabilities | undefined {
  const id = modelId.trim()
  if (!id) return undefined
  const hit = MODEL_PROFILES.find((profile) => profile.pattern.test(id))
  return hit ? { ...hit.capabilities } : undefined
}

const MODEL_ACRONYMS = new Set(['gpt', 'glm', 'vl', 'ai', 'api', 'llm', 'tts', 'ocr', 'moe', 'vl2'])

export function humanizeModelId(modelId: string): string {
  const id = modelId.trim()
  if (!id) return ''
  const known = MODEL_DISPLAY_NAMES[id.toLowerCase()]
  if (known) return known
  return id
    .split(/[-_/]/)
    .filter(Boolean)
    .map((part) =>
      MODEL_ACRONYMS.has(part.toLowerCase())
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join(' ')
}

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'gpt-4o-mini': 'GPT-4o mini',
  'gpt-4.1-mini': 'GPT-4.1 mini',
  'o4-mini': 'o4-mini',
  'deepseek-chat': 'DeepSeek Chat',
  'deepseek-reasoner': 'DeepSeek Reasoner',
  'claude-sonnet-4-5': 'Claude Sonnet 4.5',
  'claude-3-5-haiku-latest': 'Claude 3.5 Haiku',
  'qwen-plus': 'Qwen Plus',
  'qwen-max': 'Qwen Max',
  'qwen-vl-max': 'Qwen VL Max',
  'glm-4-plus': 'GLM-4 Plus',
  'glm-4v-plus': 'GLM-4V Plus',
  'moonshot-v1-8k': 'Moonshot v1 8K',
  'moonshot-v1-32k': 'Moonshot v1 32K',
  'minimax-text-01': 'MiniMax Text 01'
}

export function createModelDefinition(
  modelId: string,
  options: { name?: string; detected?: boolean } = {}
): AIModelDefinition {
  const id = modelId.trim()
  const capabilities = knownModelCapabilities(id) || { ...CHAT_ONLY }
  const definition: AIModelDefinition = {
    id,
    name: options.name?.trim() || humanizeModelId(id),
    capabilities
  }
  const maxTokens = MODEL_PROFILES.find((profile) => profile.pattern.test(id))?.maxTokens
  if (maxTokens) definition.maxTokens = maxTokens
  if (options.detected) definition.detected = true
  return definition
}

export function uniqueModels(models: AIModelDefinition[]): AIModelDefinition[] {
  const seen = new Set<string>()
  const result: AIModelDefinition[] = []
  for (const model of models) {
    const id = model.id.trim()
    if (!id) continue
    const key = id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ ...model, id, name: model.name.trim() || humanizeModelId(id) })
  }
  return result
}

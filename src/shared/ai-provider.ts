/**
 * AI 供应商类型定义。
 *
 * 设计取自 goutou 的 providers 表与 CC Switch 的「一个供应商 = 一个端点 + 一组模型」模型：
 * 路由只认显式声明的 provider + model，不再通过 Base URL / 模型族 / 分组去推断归属。
 * 旧配置里的 registryId / group / accountId / supportedModels / role 仍然原样保留，
 * 读取时不做任何强制归属判断，写回时也不删除，保证 ai-providers.json 向后兼容。
 */

export type AIProviderType =
  | 'openai-compatible'
  | 'anthropic-messages'
  | 'azure-openai'
  | 'ollama'
  | 'custom'

export type AIAuthType = 'bearer' | 'x-api-key' | 'custom-header' | 'none'

export type AIOpenAIProtocol = 'chat-completions' | 'responses'
export type AIThinkingMode = 'default' | 'disabled'

export interface AIProviderAuth {
  type: AIAuthType
  headerName?: string
}

export interface AIModelCapabilities {
  chat: boolean
  vision: boolean
  /** OCR 是 vision 的派生能力，UI 上作为「图片文字识别」标签呈现。 */
  ocr: boolean
  longContext: boolean
}

export interface AIModelDefinition {
  name: string
  id: string
  capabilities: AIModelCapabilities
  maxTokens?: number
  /** 来自端点探测（/v1/models）而不是手工添加。 */
  detected?: boolean
}

export interface AIProviderAdvancedSettings {
  timeoutMs: number
  temperature?: number
  maxTokens?: number
  stream?: boolean
  apiProtocol?: AIOpenAIProtocol
  thinking?: AIThinkingMode
  extraHeaders: Record<string, string>
}

export type AIProviderRole = 'chat' | 'strategy' | 'both'

export interface AIProviderConfig {
  id: string
  name: string
  type: AIProviderType
  baseUrl: string
  apiKey?: string
  auth: AIProviderAuth
  models: AIModelDefinition[]
  defaultModel: string
  advanced: AIProviderAdvancedSettings
  /** 供应商模板 ID（catalog 里的条目），只用于回填默认值与界面展示。 */
  templateId?: string
  note?: string
  /** 旧配置字段：保留但不参与任何路由或校验。 */
  registryId?: string
  group?: string
  accountId?: string
  supportedModels?: string[]
  role?: AIProviderRole
}

export type AIProviderStatus = 'untested' | 'connected' | 'error'

/** 结构化诊断：UI 直接显示 message + hint，不再把上游原文拼成一句长错误。 */
export type AIProviderDiagnosisCode =
  | 'OK'
  | 'NO_PROVIDER'
  | 'NO_MODEL'
  | 'MISSING_API_KEY'
  | 'INVALID_BASE_URL'
  | 'NETWORK'
  | 'AUTH'
  | 'MODEL_NOT_FOUND'
  | 'PROTOCOL_MISMATCH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'EMPTY_RESPONSE'
  | 'UPSTREAM'
  | 'UNKNOWN'

export interface AIProviderDiagnosis {
  code: AIProviderDiagnosisCode
  message: string
  hint?: string
  httpStatus?: number
  /** 上游返回的原始 error.message，便于核对中转站的分组/渠道文案。 */
  upstreamMessage?: string
  endpoint?: string
  protocol?: string
}

export interface AIProviderSummary extends Omit<AIProviderConfig, 'apiKey'> {
  hasApiKey: boolean
  isDefault: boolean
  status: AIProviderStatus
  lastTestedAt?: number
  lastError?: string
  lastDiagnosis?: AIProviderDiagnosis
}

export interface AIProviderListResult {
  success: boolean
  providers: AIProviderSummary[]
  defaultProviderId?: string
  error?: string
  /** 保存时自动修正的内容（协议、模型去重、模板偏差），不是错误。 */
  notices?: string[]
}

export interface AIProviderProbeRequest {
  providerId?: string
  baseUrl?: string
  apiKey?: string
  type?: AIProviderType
  timeoutMs?: number
}

export interface AIModelProbeEntry {
  id: string
  ownedBy?: string
  created?: number
}

export interface AIProviderProbeResult {
  success: boolean
  models: AIModelProbeEntry[]
  endpoint?: string
  latencyMs?: number
  error?: string
  diagnosis?: AIProviderDiagnosis
}

export interface AIRuntimeModelConfig {
  providerId?: string
  providerName: string
  model: string
  modelName: string
  configured: boolean
  status: AIProviderStatus
  timeoutMs?: number
}

/** 日报工作区内可选择的模型，不会修改全局默认 Provider。 */
export interface ReportModelChoice extends AIRuntimeModelConfig {
  providerId: string
  configured: true
}

export interface AIVisionRuntimeConfig extends AIRuntimeModelConfig {
  /** 图片理解模型独立于文字总结模型，由已验证的 vision/ocr capability 自动选择。 */
  source: 'default-model' | 'vision-capability' | 'unavailable'
}

export interface AiSearchProviderStatus {
  configured: boolean
  requiresConsent: boolean
  providerId?: string
  providerName?: string
  recipient?: string
}

export interface AiSearchExternalAuthorizationRequest {
  requestId: string
  providerId: string
  recipient: string
}

export interface AiSearchExternalAuthorizationResult {
  success: boolean
  error?: string
}

export interface LegacyAIConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface AIChatRequestOptions {
  /** Stable ID shared by requests and retries belonging to one conversation or task. */
  sessionId?: string
  providerId?: string
  modelId?: string
  timeoutMs?: number
  // Legacy compatibility only. New callers must use providerId/modelId.
  apiKey?: string
  baseURL?: string
  model?: string
}

export interface AIConnectionTestResult {
  success: boolean
  error?: string
  latencyMs?: number
  diagnosis?: AIProviderDiagnosis
}

export interface AIVisionTestRequest {
  providerId?: string
  modelId?: string
  prompt: string
  imageDataUrl: string
}

export interface AIVisionTestResult {
  success: boolean
  providerName?: string
  modelId?: string
  modelName?: string
  latencyMs?: number
  usage?: {
    input?: number
    output?: number
    total?: number
    estimated?: boolean
  }
  answer?: string
  code?: 'INVALID_IMAGE' | 'VISION_UNSUPPORTED' | 'API_ERROR'
  error?: string
}

import { app } from 'electron'
import { randomUUID } from 'crypto'
import fs from 'fs-extra'
import path from 'path'
import type {
  AIChatRequestOptions,
  AIConnectionTestResult,
  AIProviderConfig,
  AIProviderDiagnosis,
  AIProviderListResult,
  AIProviderProbeRequest,
  AIProviderProbeResult,
  AIProviderSummary,
  AiSearchProviderStatus,
  AIModelProbeEntry,
  AIRuntimeModelConfig,
  AIVisionRuntimeConfig,
  AIVisionTestRequest,
  AIVisionTestResult,
  LegacyAIConfig
} from '../../shared/ai-provider'
import {
  humanizeModelId,
  resolveTemplateId,
  AI_PROVIDER_TEMPLATES,
  uniqueModels,
  type AIProviderTemplate
} from '../../shared/ai-provider-catalog'
import {
  adviseProviderSetup,
  describeAIProviderAdvisor,
  type AIProviderAdvisorInfo,
  type AIProviderAdvisorReport
} from '../../shared/ai-provider-advisor'
import { AIProviderKeyStore } from '../ai-provider-key-store'

interface AIProviderMetadataFile {
  version: 1
  defaultProviderId?: string
  providers: Array<Omit<AIProviderSummary, 'hasApiKey' | 'isDefault'>>
}

type AIMessagePart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string }
type AIMessage = { role: string; content: string | AIMessagePart[] }
type AIChatDeltaHandler = (delta: string) => void
export interface AIChatToolCall {
  id: string
  name: string
  arguments: string
}
export interface AIChatToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
type AIRequestResult = {
  data: string
  finishReason?: string
  usage?: { input?: number; output?: number; total?: number; estimated?: boolean }
}
interface OpenAIResponsePayload {
  error?: { message?: string; code?: string | number; type?: string }
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }> | null
      reasoning_content?: string
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}
interface OpenAIStreamPayload {
  error?: { message?: string; code?: string | number; type?: string }
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}
interface OpenAIResponsesPayload {
  error?: { message?: string; code?: string | number; type?: string }
  incomplete_details?: { reason?: string }
  status?: string
  output_text?: string
  output?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string }>
  }>
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
}
interface OpenAIResponsesStreamPayload {
  type?: string
  delta?: string
  message?: string
  error?: { message?: string; code?: string | number; type?: string }
  response?: OpenAIResponsesPayload
}
interface AnthropicResponsePayload {
  error?: { message?: string; type?: string }
  content?: Array<{ type?: string; text?: string }>
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

export class AIProviderRequestError extends Error {
  readonly status?: number
  readonly code?: string
  readonly type?: string
  readonly responseBody?: unknown
  /** 诊断字段：上游响应 content-type（例如 502 返回的 text/html） */
  readonly contentType?: string
  /** 诊断字段：本次请求从发出到响应处理结束的耗时 */
  readonly elapsedMs?: number
  /** 诊断字段：上游返回网页而不是 JSON */
  readonly htmlInsteadOfJson?: boolean

  constructor(
    message: string,
    details: {
      status?: number
      code?: unknown
      type?: unknown
      responseBody?: unknown
      contentType?: string
      elapsedMs?: number
      htmlInsteadOfJson?: boolean
    } = {}
  ) {
    super(message)
    this.name = 'AIProviderRequestError'
    this.status = details.status
    this.code = typeof details.code === 'string' ? details.code : undefined
    this.type = typeof details.type === 'string' ? details.type : undefined
    this.responseBody = details.responseBody
    this.contentType = details.contentType
    this.elapsedMs = details.elapsedMs
    this.htmlInsteadOfJson = details.htmlInsteadOfJson
  }
}

/**
 * 供应商服务。
 *
 * 与 2.5.x 的差别：不再有「模型必须归属到某个分组账户」的硬校验。
 * 一个供应商就是一个端点 + 一组模型，保存只做格式校验；能不能用由真实请求决定，
 * 失败时返回结构化诊断（含上游原文与处理建议），而不是一句归因错误。
 */
export class AIProviderService {
  constructor(private readonly keyStore = new AIProviderKeyStore()) {}

  list(): AIProviderListResult {
    try {
      const data = this.readMetadata()
      return {
        success: true,
        defaultProviderId: data.defaultProviderId,
        providers: data.providers.map((provider) =>
          this.toSummary(provider, data.defaultProviderId)
        )
      }
    } catch {
      return { success: false, providers: [], error: 'AI Provider 配置无法读取' }
    }
  }

  /** 模板目录：设置页的供应商选择器直接用这份数据。 */
  getProviderCatalog(): AIProviderTemplate[] {
    return AI_PROVIDER_TEMPLATES
  }

  getAdvisorInfo(): AIProviderAdvisorInfo {
    return describeAIProviderAdvisor()
  }

  /** 保存前预览建议：只读本地表单，不写配置、不联网。 */
  previewSetup(provider: AIProviderConfig): AIProviderAdvisorReport {
    const storedKey = this.keyStore.get(provider.id).key
    return adviseProviderSetup({
      ...provider,
      hasApiKey: Boolean(provider.apiKey?.trim() || storedKey)
    })
  }

  getRuntimeConfig(): AIRuntimeModelConfig {
    const result = this.list()
    const chatProviders = result.providers.filter((item) => item.role !== 'strategy')
    const provider =
      chatProviders.find((item) => item.id === result.defaultProviderId) || chatProviders[0]
    const model = provider?.models.find((item) => item.id === provider.defaultModel)
    return {
      providerId: provider?.id,
      providerName: provider?.name || '尚未配置',
      model: provider?.defaultModel || '',
      modelName: model?.name || provider?.defaultModel || '尚未选择模型',
      configured: Boolean(
        provider && provider.models.length && (provider.hasApiKey || !needsApiKey(provider))
      ),
      status: provider?.status || 'untested',
      timeoutMs: provider?.advanced.timeoutMs
    }
  }

  /**
   * 诊断用：当前默认 Provider 的 endpoint host。
   * 只返回 hostname（不含路径与 query），避免把凭据或敏感 query 带进日志/终端。
   */
  getRuntimeEndpointHost(): string | undefined {
    try {
      const resolved = this.resolveProvider(undefined)
      return endpointHost(resolved.provider.baseUrl)
    } catch {
      return undefined
    }
  }

  getVisionRuntimeConfig(): AIVisionRuntimeConfig {
    const result = this.list()
    const chatProviders = result.providers.filter((item) => item.role !== 'strategy')
    const defaultProvider = chatProviders.find((item) => item.id === result.defaultProviderId)
    const defaultModel = defaultProvider?.models.find(
      (item) => item.id === defaultProvider.defaultModel
    )
    if (
      defaultProvider &&
      defaultModel &&
      (defaultProvider.hasApiKey || !needsApiKey(defaultProvider)) &&
      (defaultModel.capabilities.vision || defaultModel.capabilities.ocr)
    ) {
      return {
        providerId: defaultProvider.id,
        providerName: defaultProvider.name,
        model: defaultModel.id,
        modelName: defaultModel.name || defaultModel.id,
        configured: true,
        status: defaultProvider.status,
        timeoutMs: defaultProvider.advanced.timeoutMs,
        source: 'default-model'
      }
    }

    for (const provider of chatProviders) {
      if (!provider.hasApiKey && needsApiKey(provider)) continue
      const model =
        provider.models.find(
          (item) =>
            item.id === provider.defaultModel && (item.capabilities.vision || item.capabilities.ocr)
        ) || provider.models.find((item) => item.capabilities.vision || item.capabilities.ocr)
      if (!model) continue
      return {
        providerId: provider.id,
        providerName: provider.name,
        model: model.id,
        modelName: model.name || model.id,
        configured: true,
        status: provider.status,
        timeoutMs: provider.advanced.timeoutMs,
        source: 'vision-capability'
      }
    }

    return {
      providerName: '尚未配置',
      model: '',
      modelName: '尚未验证图片理解模型',
      configured: false,
      status: 'untested',
      source: 'unavailable'
    }
  }

  getAiSearchProviderStatus(providerId?: string): AiSearchProviderStatus {
    const result = this.list()
    const chatProviders = result.providers.filter((item) => item.role !== 'strategy')
    const provider =
      chatProviders.find((item) => item.id === providerId) ||
      chatProviders.find((item) => item.id === result.defaultProviderId) ||
      chatProviders[0]
    if (!provider) return { configured: false, requiresConsent: false }
    const configured = Boolean(
      provider.models.length && (provider.hasApiKey || !needsApiKey(provider))
    )
    return {
      configured,
      requiresConsent: configured && !isLocalProvider(provider),
      providerId: provider.id,
      providerName: provider.name,
      recipient: normalizeProviderRecipient(provider.baseUrl)
    }
  }

  /**
   * 保存供应商。
   *
   * 只做格式校验与原地规范化：
   *  - 去掉 Base URL 末尾的 /chat/completions 等具体路径；
   *  - 合并重复模型；
   *  - 默认模型不在列表时改成第一个；
   *  - 端点或模型变化时把连接状态重置为未测试。
   * 不判断模型属于哪个「分组」，因此中转站上的新模型名可以正常保存。
   */
  save(input: AIProviderConfig): AIProviderListResult {
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    const models = uniqueModels(input.models)
    const candidate: AIProviderConfig = { ...input, baseUrl, models }
    const validationError = validateProvider(candidate)
    if (validationError) return { success: false, providers: [], error: validationError }

    const data = this.readMetadata()
    const existing = data.providers.find((provider) => provider.id === input.id)

    if (input.apiKey?.trim()) {
      const saved = this.keyStore.save(input.id, input.apiKey.trim())
      if (!saved.success) return { success: false, providers: [], error: saved.error }
    } else if (needsApiKey(candidate) && !this.keyStore.get(input.id).key) {
      return { success: false, providers: [], error: '请填写 API Key' }
    }

    const notices: string[] = []
    if (baseUrl && baseUrl !== input.baseUrl.trim()) {
      notices.push('已去掉 Base URL 末尾的接口路径，只保留基础地址')
    }
    const defaultModel = models.some((model) => model.id === input.defaultModel)
      ? input.defaultModel
      : models[0]?.id || ''
    if (defaultModel && defaultModel !== input.defaultModel) {
      notices.push(`默认模型已调整为 ${defaultModel}`)
    }
    const templateId = resolveTemplateId({ templateId: input.templateId, baseUrl, models })

    const previousModelIds = (existing?.models || []).map((model) => model.id).join('|')
    const endpointChanged = Boolean(
      existing &&
      (existing.baseUrl !== baseUrl ||
        previousModelIds !== models.map((model) => model.id).join('|'))
    )
    const status = endpointChanged ? 'untested' : existing?.status || 'untested'
    if (endpointChanged) notices.push('端点或模型有变化，连接状态已重置为未测试')

    const metadata: Omit<AIProviderSummary, 'hasApiKey' | 'isDefault'> = {
      id: input.id.trim(),
      name: input.name.trim(),
      type: input.type,
      baseUrl,
      auth: input.auth,
      models,
      defaultModel,
      advanced: input.advanced,
      templateId,
      note: input.note?.trim() || undefined,
      role: input.role || 'chat',
      status,
      lastTestedAt: endpointChanged ? undefined : existing?.lastTestedAt,
      lastError: endpointChanged ? undefined : existing?.lastError,
      lastDiagnosis: endpointChanged ? undefined : existing?.lastDiagnosis,
      // 旧字段原样保留，避免旧版本读取时丢信息。
      ...(input.registryId ? { registryId: input.registryId } : {}),
      ...(input.group ? { group: input.group } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.supportedModels ? { supportedModels: [...input.supportedModels] } : {}),
      ...(existing?.registryId ? { registryId: existing.registryId } : {}),
      ...(existing?.group ? { group: existing.group } : {}),
      ...(existing?.accountId ? { accountId: existing.accountId } : {})
    }

    const index = data.providers.findIndex((provider) => provider.id === metadata.id)
    if (index >= 0) data.providers[index] = metadata
    else data.providers.push(metadata)
    if (!data.defaultProviderId) data.defaultProviderId = metadata.id
    this.writeMetadata(data)

    const result = this.list()
    if (notices.length) result.notices = notices
    return result
  }

  delete(providerId: string): AIProviderListResult {
    const data = this.readMetadata()
    data.providers = data.providers.filter((provider) => provider.id !== providerId)
    if (data.defaultProviderId === providerId) data.defaultProviderId = data.providers[0]?.id
    const cleared = this.keyStore.clear(providerId)
    if (!cleared.success) return { success: false, providers: [], error: cleared.error }
    this.writeMetadata(data)
    return this.list()
  }

  setDefault(providerId: string): AIProviderListResult {
    const data = this.readMetadata()
    if (!data.providers.some((provider) => provider.id === providerId)) {
      return { success: false, providers: [], error: '供应商不存在' }
    }
    data.defaultProviderId = providerId
    this.writeMetadata(data)
    return this.list()
  }

  migrateLegacy(config: LegacyAIConfig): AIProviderListResult {
    const data = this.readMetadata()
    if (data.providers.length) return this.list()
    const provider = deepSeekProvider(config.baseUrl, config.model)
    if (config.apiKey?.trim()) {
      const saved = this.keyStore.save(provider.id, config.apiKey.trim())
      if (!saved.success) return { success: false, providers: [], error: saved.error }
    }
    data.providers = [stripRuntimeFields(provider)]
    data.defaultProviderId = provider.id
    this.writeMetadata(data)
    return this.list()
  }

  /**
   * 连接测试。
   *
   * Chat Completions 与 Responses 相互回退一次：中转站只用其中一个时也能测通。
   * 失败时返回结构化诊断，保留上游原文，便于区分「Key 错」「模型不存在」「分组无渠道」。
   */
  async test(providerId: string): Promise<AIConnectionTestResult> {
    const startedAt = Date.now()
    const list = this.list()
    const provider = list.providers.find((item) => item.id === providerId)
    if (!provider) {
      return {
        success: false,
        error: '供应商不存在',
        diagnosis: { code: 'NO_PROVIDER', message: '供应商不存在，可能已被删除。' }
      }
    }
    const key = this.keyStore.get(providerId).key || ''
    const model = provider.defaultModel || provider.models[0]?.id || ''
    if (!model) {
      const diagnosis: AIProviderDiagnosis = {
        code: 'NO_MODEL',
        message: '这个供应商还没有模型，无法测试。',
        hint: '点「探测模型」从端点读取模型列表，或手动添加一个模型 ID。'
      }
      this.updateTestStatus(providerId, 'error', diagnosis)
      return { success: false, error: diagnosis.message, diagnosis }
    }

    const tried: string[] = []
    let lastError: unknown
    for (const protocol of protocolCandidates(provider)) {
      tried.push(protocol)
      const attempt: AIProviderSummary = {
        ...provider,
        advanced: { ...provider.advanced, apiProtocol: protocol, timeoutMs: 30_000 }
      }
      try {
        const result = await requestProvider(
          attempt,
          key,
          model,
          [{ role: 'user', content: 'Reply with OK.' }],
          true
        )
        if (!result.data.trim()) {
          throw new AIProviderRequestError('端点返回了空响应', { status: 200 })
        }
        this.updateTestStatus(providerId, 'connected')
        return {
          success: true,
          latencyMs: Date.now() - startedAt,
          diagnosis: {
            code: 'OK',
            message: `连接正常（${protocol}，模型 ${model}）`,
            protocol
          }
        }
      } catch (error) {
        lastError = error
        if (!shouldFallbackProtocol(error)) break
      }
    }

    const diagnosis = diagnoseProviderError(lastError, {
      provider,
      model,
      protocol: tried[tried.length - 1]
    })
    if (tried.length > 1) {
      diagnosis.hint = [diagnosis.hint, `已尝试 ${tried.join(' 与 ')} 两种协议。`]
        .filter(Boolean)
        .join(' ')
    }
    this.updateTestStatus(providerId, 'error', diagnosis)
    return {
      success: false,
      error: diagnosis.message,
      latencyMs: Date.now() - startedAt,
      diagnosis
    }
  }

  /**
   * 读取端点实际提供的模型。
   *
   * OpenAI 兼容端点：GET {baseUrl}/models
   * Ollama：GET {baseUrl}/api/tags（/v1 变体与根地址都试一次）
   * 这样中转站「有哪些模型」不再靠猜，避免照抄别家的模型 ID。
   */
  async probeModels(request: AIProviderProbeRequest): Promise<AIProviderProbeResult> {
    const startedAt = Date.now()
    let baseUrl = ''
    let apiKey = ''
    let type: AIProviderSummary['type'] = 'openai-compatible'
    let auth: AIProviderSummary['auth'] = { type: 'bearer' }

    if (request.providerId) {
      const provider = this.list().providers.find((item) => item.id === request.providerId)
      if (!provider) {
        return {
          success: false,
          models: [],
          error: '供应商不存在',
          diagnosis: { code: 'NO_PROVIDER', message: '供应商不存在，可能已被删除。' }
        }
      }
      baseUrl = normalizeBaseUrl(request.baseUrl || provider.baseUrl)
      // 编辑时可能已经改过地址或刚填了 Key：优先用表单里的值，密钥仍可从安全存储取。
      apiKey = request.apiKey?.trim() || this.keyStore.get(provider.id).key || ''
      type = provider.type
      auth = provider.auth
      if (needsApiKey(provider) && !apiKey) {
        return {
          success: false,
          models: [],
          error: '缺少 API Key',
          diagnosis: {
            code: 'MISSING_API_KEY',
            message: '这个端点需要 API Key 才能读取模型列表。',
            hint: '先在表单里填 API Key；还没保存的配置可以直接在探测框里填。'
          }
        }
      }
    } else {
      baseUrl = normalizeBaseUrl(request.baseUrl || '')
      apiKey = request.apiKey?.trim() || ''
      type = request.type || 'openai-compatible'
    }

    if (!baseUrl) {
      return {
        success: false,
        models: [],
        error: 'Base URL 不能为空',
        diagnosis: {
          code: 'INVALID_BASE_URL',
          message: 'Base URL 不能为空。',
          hint: '填中转站或官方端点给你的 /v1 地址。'
        }
      }
    }

    const endpoints = probeEndpoints(baseUrl, type)
    let lastError: unknown
    for (const endpoint of endpoints) {
      try {
        const payload = await fetchWithTimeout(
          endpoint,
          { method: 'GET', headers: buildProbeHeaders(auth, apiKey) },
          Math.min(request.timeoutMs || 20_000, 60_000),
          undefined,
          async (response) => {
            if (!response.ok) {
              const body = await response.text()
              throw new AIProviderRequestError(`读取模型列表失败 (${response.status})`, {
                status: response.status,
                responseBody: body.slice(0, 800),
                contentType: response.headers.get('content-type') || ''
              })
            }
            return (await response.json()) as unknown
          }
        )
        const models = parseProbeModels(payload)
        if (!models.length) {
          return {
            success: true,
            models: [],
            endpoint,
            latencyMs: Date.now() - startedAt,
            error: '端点返回了空的模型列表',
            diagnosis: {
              code: 'EMPTY_RESPONSE',
              message: '端点响应里没有模型。',
              hint: '有些中转站不实现 /models，只能手动填模型 ID。',
              endpoint
            }
          }
        }
        return { success: true, models, endpoint, latencyMs: Date.now() - startedAt }
      } catch (error) {
        lastError = error
      }
    }

    const diagnosis = diagnoseProviderError(lastError, {
      provider: {
        ...emptyProvider(baseUrl, type, auth),
        id: request.providerId || 'probe',
        name: '模型探测'
      },
      model: '',
      endpoint: endpoints[0],
      protocol: 'GET /models'
    })
    return {
      success: false,
      models: [],
      endpoint: endpoints[0],
      latencyMs: Date.now() - startedAt,
      error: diagnosis.message,
      diagnosis
    }
  }

  async chat(
    messages: Array<{ role: string; content: string }>,
    options?: AIChatRequestOptions,
    signal?: AbortSignal,
    onDelta?: AIChatDeltaHandler
  ): Promise<{
    success: boolean
    data?: string
    finishReason?: string
    usage?: { input?: number; output?: number; total?: number; estimated?: boolean }
    error?: string
    errorCode?: string
    errorStatus?: number
    errorType?: string
  }> {
    try {
      return { success: true, ...(await this.request(messages, options, false, signal, onDelta)) }
    } catch (error) {
      if (signal?.aborted) throw error
      return { success: false, error: safeAIError(error), ...aiProviderErrorDetails(error) }
    }
  }

  async chatWithTools(
    messages: Array<Record<string, unknown>>,
    tools: AIChatToolDefinition[],
    options?: AIChatRequestOptions,
    signal?: AbortSignal
  ): Promise<{
    success: boolean
    data?: string
    toolCalls?: AIChatToolCall[]
    usage?: { input?: number; output?: number; total?: number; estimated?: boolean }
    error?: string
    errorStatus?: number
    errorCode?: string
    errorType?: string
    errorContentType?: string
    elapsedMs?: number
    timedOut?: boolean
    htmlInsteadOfJson?: boolean
  }> {
    try {
      if (options?.apiKey) throw new Error('Tool Calling 不支持 legacy provider 配置')
      const resolved = this.resolveProvider(options)
      if (
        resolved.provider.type !== 'openai-compatible' ||
        resolved.provider.advanced.apiProtocol === 'responses'
      ) {
        throw new Error('当前 Provider 协议暂不支持 Tool Calling POC')
      }
      const result = await requestOpenAICompatibleWithTools(
        resolved.provider,
        resolved.key,
        resolved.model,
        messages,
        tools,
        signal
      )
      return { success: true, ...result }
    } catch (error) {
      if (signal?.aborted) throw error
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
      return {
        success: false,
        error: safeAIError(error),
        timedOut,
        htmlInsteadOfJson:
          error instanceof AIProviderRequestError ? Boolean(error.htmlInsteadOfJson) : false,
        ...(error instanceof AIProviderRequestError
          ? {
              ...(error.status !== undefined ? { errorStatus: error.status } : {}),
              ...(error.code ? { errorCode: error.code } : {}),
              ...(error.type ? { errorType: error.type } : {}),
              ...(error.contentType ? { errorContentType: error.contentType } : {}),
              ...(error.elapsedMs !== undefined ? { elapsedMs: error.elapsedMs } : {})
            }
          : {})
      }
    }
  }

  /**
   * 多模态图片理解。
   * 输入:text + image parts 的 messages,返回 AI 文本响应。
   * 与 testVision 区别:不校验 prompt,不写入 capability marker(供 ImageInsightService 复用)。
   */
  async analyzeImage(
    messages: Array<{
      role: string
      content: string | Array<{ type: 'text'; text: string } | { type: 'image'; dataUrl: string }>
    }>,
    options?: AIChatRequestOptions
  ): Promise<{
    success: boolean
    data?: string
    usage?: { input?: number; output?: number; total?: number; estimated?: boolean }
    error?: string
  }> {
    try {
      const imagePart = messages
        .flatMap((message) => (typeof message.content === 'string' ? [] : message.content))
        .find((part) => part.type === 'image')
      if (!imagePart || imagePart.type !== 'image') throw new Error('图片识别请求缺少图片数据')
      const imageError = validateVisionImage(imagePart.dataUrl)
      if (imageError) throw new Error(imageError)
      const result = await this.request(messages as AIMessage[], options)
      if (options?.providerId && options.modelId) {
        this.markCapabilities(options.providerId, options.modelId, { vision: true, ocr: true })
      }
      return { success: true, ...result }
    } catch (error) {
      return { success: false, error: safeAIError(error) }
    }
  }

  async testVision(request: AIVisionTestRequest): Promise<AIVisionTestResult> {
    const startedAt = Date.now()
    const imageError = validateVisionImage(request.imageDataUrl)
    if (imageError) return { success: false, code: 'INVALID_IMAGE', error: imageError }
    if (!request.prompt.trim()) {
      return { success: false, code: 'INVALID_IMAGE', error: '请填写图片识别提示词' }
    }
    try {
      const resolved = this.resolveProvider(request)
      const result = await requestProvider(resolved.provider, resolved.key, resolved.model, [
        {
          role: 'user',
          content: [
            { type: 'text', text: request.prompt.trim() },
            { type: 'image', dataUrl: request.imageDataUrl }
          ]
        }
      ])
      if (!result.data.trim()) throw new Error('API 未返回识别内容')
      this.markVisionCapability(resolved.provider.id, resolved.model)
      const model = resolved.provider.models.find((item) => item.id === resolved.model)
      return {
        success: true,
        providerName: resolved.provider.name,
        modelId: resolved.model,
        modelName: model?.name || resolved.model,
        latencyMs: Date.now() - startedAt,
        usage: result.usage,
        answer: result.data
      }
    } catch (error) {
      const failure = visionFailure(error)
      return { success: false, ...failure, latencyMs: Date.now() - startedAt }
    }
  }

  private async request(
    messages: AIMessage[],
    options?: AIChatRequestOptions,
    testing = false,
    signal?: AbortSignal,
    onDelta?: AIChatDeltaHandler
  ): Promise<{
    data: string
    finishReason?: string
    usage?: { input?: number; output?: number; total?: number; estimated?: boolean }
  }> {
    if (options?.apiKey) return this.requestLegacy(messages, options, signal, onDelta)
    const resolved = this.resolveProvider(options)
    const provider = options?.timeoutMs
      ? {
          ...resolved.provider,
          advanced: { ...resolved.provider.advanced, timeoutMs: options.timeoutMs }
        }
      : resolved.provider
    return requestProvider(
      provider,
      resolved.key,
      resolved.model,
      messages,
      testing,
      signal,
      onDelta,
      options?.sessionId
    )
  }

  /**
   * 路由：显式 provider/model 优先，其次是默认供应商。
   * 找不到时给出可用列表，不再做「模型族 → 分组 → 账户」的推断。
   */
  private resolveProvider(options?: { providerId?: string; modelId?: string }): {
    provider: AIProviderSummary
    model: string
    key: string
  } {
    const list = this.list()
    const usable = list.providers.filter((item) => item.role !== 'strategy')
    if (!usable.length) {
      throw new Error('尚未配置 AI 供应商。打开 设置 → AI 模型 添加一个端点。')
    }
    const wantedModel = options?.modelId?.trim()

    if (options?.providerId) {
      const explicit = list.providers.find((item) => item.id === options.providerId)
      if (!explicit) throw new Error(`供应商 ${options.providerId} 不存在`)
      if (wantedModel && !explicit.models.some((model) => model.id.trim() === wantedModel)) {
        const owner = usable.find((item) =>
          item.models.some((model) => model.id.trim() === wantedModel)
        )
        throw new Error(
          owner
            ? `模型 ${wantedModel} 属于供应商「${owner.name}」(${owner.id})，不属于「${explicit.name}」(${explicit.id})。`
            : `供应商「${explicit.name}」(${explicit.id}) 里没有模型 ${wantedModel}。`
        )
      }
      const model = wantedModel || explicit.defaultModel || explicit.models[0]?.id || ''
      if (!model) throw new Error(`供应商「${explicit.name}」还没有配置模型`)
      return { provider: explicit, model, key: this.requireKey(explicit) }
    }

    if (wantedModel) {
      const owners = usable.filter((item) =>
        item.models.some((model) => model.id.trim() === wantedModel)
      )
      const preferred = owners.find((item) => item.id === list.defaultProviderId) || owners[0]
      if (preferred) {
        return { provider: preferred, model: wantedModel, key: this.requireKey(preferred) }
      }
      throw new Error(
        `没有任何供应商声明模型 ${wantedModel}。已配置模型：${formatModelInventory(usable)}`
      )
    }

    const provider = usable.find((item) => item.id === list.defaultProviderId) || usable[0]
    const model = provider.defaultModel || provider.models[0]?.id || ''
    if (!model) throw new Error(`默认供应商「${provider.name}」还没有配置模型`)
    return { provider, model, key: this.requireKey(provider) }
  }

  private requireKey(provider: AIProviderSummary): string {
    const key = this.keyStore.get(provider.id).key || ''
    if (needsApiKey(provider) && !key) {
      throw new Error(`供应商「${provider.name}」尚未配置 API Key`)
    }
    return key
  }

  private async requestLegacy(
    messages: AIMessage[],
    options: AIChatRequestOptions,
    signal?: AbortSignal,
    onDelta?: AIChatDeltaHandler
  ): Promise<AIRequestResult> {
    const provider = deepSeekProvider(options.baseURL, options.model)
    return requestProvider(
      provider,
      options.apiKey || '',
      options.model || provider.defaultModel,
      messages,
      false,
      signal,
      onDelta,
      options?.sessionId
    )
  }

  private updateTestStatus(
    providerId: string,
    status: 'connected' | 'error',
    diagnosis?: AIProviderDiagnosis
  ): void {
    const data = this.readMetadata()
    const provider = data.providers.find((item) => item.id === providerId)
    if (!provider) return
    provider.status = status
    provider.lastTestedAt = Date.now()
    provider.lastError = status === 'error' ? diagnosis?.message : undefined
    provider.lastDiagnosis = diagnosis
    this.writeMetadata(data)
  }

  private markVisionCapability(providerId: string, modelId: string): void {
    this.markCapabilities(providerId, modelId, { vision: true, ocr: true })
  }

  /**
   * 标记模型已验证的 capabilities(已存在则跳过)。
   * OCR 跟随 vision:几乎所有 vision 模型都能 OCR,标记 vision 时同步标记 ocr。
   */
  private markCapabilities(
    providerId: string,
    modelId: string,
    caps: { vision?: boolean; ocr?: boolean }
  ): void {
    const data = this.readMetadata()
    const provider = data.providers.find((item) => item.id === providerId)
    const model = provider?.models.find((item) => item.id === modelId)
    if (!provider || !model) return
    // 老配置可能没有 ocr 字段,补默认 false
    if (typeof model.capabilities.ocr !== 'boolean') model.capabilities.ocr = false
    let changed = false
    if (caps.vision === true && !model.capabilities.vision) {
      model.capabilities.vision = true
      // vision 开启默认带 ocr(派生能力)
      if (!model.capabilities.ocr) {
        model.capabilities.ocr = true
      }
      changed = true
    }
    if (caps.ocr === true && !model.capabilities.ocr) {
      model.capabilities.ocr = true
      changed = true
    }
    if (changed) this.writeMetadata(data)
  }

  private toSummary(
    provider: Omit<AIProviderSummary, 'hasApiKey' | 'isDefault'>,
    defaultProviderId?: string
  ): AIProviderSummary {
    const templateId = resolveTemplateId({
      templateId: provider.templateId,
      baseUrl: provider.baseUrl,
      models: provider.models || []
    })
    return {
      ...provider,
      templateId,
      hasApiKey: Boolean(this.keyStore.get(provider.id).key),
      isDefault: provider.id === defaultProviderId
    }
  }

  private readMetadata(): AIProviderMetadataFile {
    const filePath = this.metadataPath
    if (!fs.existsSync(filePath)) return { version: 1, providers: [] }
    const data = fs.readJsonSync(filePath) as AIProviderMetadataFile
    if (data.version !== 1 || !Array.isArray(data.providers)) {
      throw new Error('invalid provider metadata')
    }
    let migrated = false
    for (const provider of data.providers) {
      const stored = provider as Record<string, unknown>
      if ('aiSearchDataConsent' in stored) {
        delete stored.aiSearchDataConsent
        migrated = true
      }
      for (const model of provider.models) {
        if (typeof model.capabilities.ocr !== 'boolean') {
          model.capabilities.ocr = model.capabilities.vision === true
          migrated = true
        }
        if (!model.name) {
          model.name = humanizeModelId(model.id)
          migrated = true
        }
      }
      if (!provider.templateId) {
        provider.templateId = resolveTemplateId({
          baseUrl: provider.baseUrl,
          models: provider.models
        })
        migrated = true
      }
    }
    if (migrated) this.writeMetadata(data)
    return data
  }

  private writeMetadata(data: AIProviderMetadataFile): void {
    fs.ensureDirSync(path.dirname(this.metadataPath))
    fs.writeJsonSync(this.metadataPath, data, { spaces: 2 })
  }

  private get metadataPath(): string {
    return path.join(app.getPath('userData'), 'ai-providers.json')
  }
}

function normalizeBaseUrl(value: string): string {
  let url = String(value || '')
    .trim()
    .replace(/\/+$/, '')
  // 用户常把完整接口路径贴进来，保存前裁到基础地址。
  url = url.replace(/\/(?:chat\/completions|responses|completions)$/i, '')
  return url.replace(/\/+$/, '')
}

function validateProvider(provider: AIProviderConfig): string | undefined {
  if (!provider.id.trim() || !/^[a-z0-9][a-z0-9-_]*$/i.test(provider.id))
    return '供应商 ID 格式不正确'
  if (!provider.name.trim()) return '供应商名称不能为空'
  if (!provider.baseUrl.trim()) return 'Base URL 不能为空'
  try {
    const url = new URL(provider.baseUrl)
    if (!/^https?:$/.test(url.protocol)) return 'Base URL 只支持 http/https'
  } catch {
    return 'Base URL 不是合法地址'
  }
  if (!provider.models.length) return '请至少添加一个模型'
  if (provider.models.some((model) => !model.id.trim())) return '模型 ID 不能为空'
  if (provider.auth.type === 'custom-header' && !provider.auth.headerName?.trim())
    return '请填写自定义认证字段'
  if (
    provider.advanced.apiProtocol &&
    !['chat-completions', 'responses'].includes(provider.advanced.apiProtocol)
  )
    return 'OpenAI API 接口配置不正确'
  return undefined
}

function deepSeekProvider(baseUrl?: string, model?: string): AIProviderSummary {
  const modelId = model?.trim() || 'deepseek-chat'
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai-compatible',
    baseUrl: baseUrl?.trim() || 'https://api.deepseek.com/v1',
    auth: { type: 'bearer' },
    models: [
      {
        name: modelId === 'deepseek-chat' ? 'DeepSeek Chat' : modelId,
        id: modelId,
        capabilities: { chat: true, vision: false, ocr: false, longContext: true }
      }
    ],
    defaultModel: modelId,
    advanced: { timeoutMs: 120_000, temperature: 0.7, maxTokens: 4096, extraHeaders: {} },
    templateId: 'deepseek',
    role: 'chat',
    hasApiKey: false,
    isDefault: true,
    status: 'untested'
  }
}

function emptyProvider(
  baseUrl: string,
  type: AIProviderSummary['type'],
  auth: AIProviderSummary['auth']
): AIProviderSummary {
  return {
    id: 'probe',
    name: '模型探测',
    type,
    baseUrl,
    auth,
    models: [],
    defaultModel: '',
    advanced: {
      timeoutMs: 20_000,
      temperature: 0.7,
      maxTokens: 4096,
      stream: false,
      apiProtocol: 'chat-completions',
      thinking: 'default',
      extraHeaders: {}
    },
    hasApiKey: true,
    isDefault: false,
    status: 'untested'
  }
}

/** 诊断用：只取 endpoint 的 hostname，不保留路径与 query。 */
function endpointHost(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname || undefined
  } catch {
    return undefined
  }
}

function stripRuntimeFields(
  provider: AIProviderSummary
): Omit<AIProviderSummary, 'hasApiKey' | 'isDefault'> {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    auth: provider.auth,
    models: provider.models,
    defaultModel: provider.defaultModel,
    advanced: provider.advanced,
    ...(provider.templateId ? { templateId: provider.templateId } : {}),
    ...(provider.role ? { role: provider.role } : {}),
    status: provider.status,
    lastTestedAt: provider.lastTestedAt,
    lastError: provider.lastError
  }
}

function isLocalProvider(provider: Pick<AIProviderSummary, 'type' | 'baseUrl'>): boolean {
  try {
    const hostname = new URL(provider.baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    return false
  }
}

function normalizeProviderRecipient(baseUrl: string): string {
  try {
    const url = new URL(baseUrl.trim())
    const pathname = url.pathname.replace(/\/+$/, '')
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`
  } catch {
    return baseUrl.trim().replace(/\/+$/, '')
  }
}

function needsApiKey(provider: Pick<AIProviderConfig, 'type' | 'auth'>): boolean {
  return provider.type !== 'ollama' && provider.auth.type !== 'none'
}

function formatModelInventory(providers: AIProviderSummary[]): string {
  const entries = providers
    .map((provider) => {
      const models = provider.models.map((model) => model.id).filter(Boolean)
      return models.length ? `${provider.name}（${models.join('、')}）` : undefined
    })
    .filter((item): item is string => Boolean(item))
  return entries.length ? entries.join('；') : '当前没有任何模型'
}

function protocolCandidates(provider: AIProviderSummary): Array<'chat-completions' | 'responses'> {
  if (provider.type === 'anthropic-messages' || provider.type === 'ollama') {
    return ['chat-completions']
  }
  return provider.advanced.apiProtocol === 'responses'
    ? ['responses', 'chat-completions']
    : ['chat-completions', 'responses']
}

/** 只有「路径不对」类的失败才值得换协议重试；模型不存在、鉴权失败重试无意义。 */
function shouldFallbackProtocol(error: unknown): boolean {
  if (error instanceof AIProviderRequestError) {
    if (error.htmlInsteadOfJson) return true
    if (error.status === 404 || error.status === 405 || error.status === 415) return true
    const text = `${error.message} ${stringifyBody(error.responseBody)}`.toLowerCase()
    if (/not supported by any configured account|无可用渠道|no available channel/.test(text)) {
      return false
    }
    return /unknown (?:url|endpoint|path)|cannot post|method not allowed|not found/.test(text)
  }
  return false
}

function stringifyBody(body: unknown): string {
  if (!body) return ''
  if (typeof body === 'string') return body
  try {
    return JSON.stringify(body)
  } catch {
    return ''
  }
}

const UPSTREAM_CHANNEL_HINT =
  '这是上游（多为中转站）自身的渠道/分组报错：当前 API Key 所属分组里没有这个模型的可用渠道。到中转站后台确认分组与可用模型，或用「探测模型」读取该 Key 实际能用的模型名。'

/**
 * 把请求失败翻译成可执行的诊断。
 * 上游原文单独保留，便于用户拿去找中转站核对，而不是被本地文案盖掉。
 */
function diagnoseProviderError(
  error: unknown,
  context: { provider: AIProviderSummary; model: string; endpoint?: string; protocol?: string }
): AIProviderDiagnosis {
  const endpoint =
    context.endpoint ||
    (() => {
      try {
        return context.provider.type === 'anthropic-messages'
          ? `${normalizeBaseUrl(context.provider.baseUrl)}/messages`
          : `${normalizeBaseUrl(context.provider.baseUrl)}/chat/completions`
      } catch {
        return undefined
      }
    })()
  const base = {
    endpoint,
    protocol: context.protocol,
    upstreamMessage: undefined as string | undefined
  }

  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return {
      ...base,
      code: 'TIMEOUT',
      message: '请求超时',
      hint: '端点没有在超时时间内返回。检查网络或代理；自建服务可以调大超时。'
    }
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { ...base, code: 'NETWORK', message: '请求已被取消' }
  }
  if (error instanceof AIProviderRequestError) {
    const upstream = extractUpstreamMessage(error)
    const text = upstream || error.message
    const status = error.status
    if (status === 401 || status === 403) {
      return {
        ...base,
        code: 'AUTH',
        httpStatus: status,
        upstreamMessage: upstream,
        message: `认证失败（HTTP ${status}）：${text}`,
        hint: 'API Key 不正确、已过期，或没有这个模型的权限。到供应商后台重新生成 Key。'
      }
    }
    if (status === 429) {
      return {
        ...base,
        code: 'RATE_LIMIT',
        httpStatus: status,
        upstreamMessage: upstream,
        message: `触发限流（HTTP 429）：${text}`,
        hint: '稍后重试，或到供应商后台查看额度与并发限制。'
      }
    }
    if (
      /not supported by any configured account|无可用渠道|no available channel|当前分组/i.test(text)
    ) {
      return {
        ...base,
        code: 'MODEL_NOT_FOUND',
        httpStatus: status,
        upstreamMessage: upstream,
        message: `上游拒绝了这个模型：${text}`,
        hint: UPSTREAM_CHANNEL_HINT
      }
    }
    if (
      /model.*(?:not found|does not exist|unsupported|not support)|unknown model|模型不存在|无效的模型/i.test(
        text
      )
    ) {
      return {
        ...base,
        code: 'MODEL_NOT_FOUND',
        httpStatus: status,
        upstreamMessage: upstream,
        message: `端点没有模型 ${context.model || '（未指定）'}：${text}`,
        hint: '点「探测模型」读取端点实际提供的模型 ID，再把它加进模型列表。'
      }
    }
    if (error.htmlInsteadOfJson) {
      return {
        ...base,
        code: 'PROTOCOL_MISMATCH',
        httpStatus: status,
        upstreamMessage: upstream,
        message: `端点返回了网页而不是 JSON（HTTP ${status || '未知'}）`,
        hint: 'Base URL 可能少了 /v1，或路径不对；也可能需要切到另一种协议。'
      }
    }
    if (status === 404) {
      return {
        ...base,
        code: 'PROTOCOL_MISMATCH',
        httpStatus: status,
        upstreamMessage: upstream,
        message: `接口路径不存在（HTTP 404）：${text}`,
        hint: '确认 Base URL 是 /v1 结尾的基础地址，并且该端点实现了这套协议。'
      }
    }
    return {
      ...base,
      code: 'UPSTREAM',
      httpStatus: status,
      upstreamMessage: upstream,
      message: status ? `上游返回 HTTP ${status}：${text}` : text,
      hint: '这是供应商侧的报错。可以点「探测模型」确认端点与模型名，或到供应商后台查看渠道状态。'
    }
  }

  const raw = error instanceof Error ? error.message : String(error)
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network/i.test(raw)) {
    const local = isLocalProvider(context.provider)
    return {
      ...base,
      code: 'NETWORK',
      message: `连接不上端点：${raw}`,
      hint: local
        ? '本地服务可能没有启动。先确认 Ollama / LM Studio 已经在监听对应端口。'
        : '检查网络、代理和 Base URL 的域名是否正确。'
    }
  }
  return {
    ...base,
    code: 'UNKNOWN',
    message: raw || '未知错误',
    hint: '如果重复出现，把完整报错发出来排查。'
  }
}

function extractUpstreamMessage(error: AIProviderRequestError): string | undefined {
  const body = error.responseBody
  if (typeof body === 'string') return body.slice(0, 400)
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const candidates = [record.message, record.msg, record.error, record.detail]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 400)
      if (candidate && typeof candidate === 'object') {
        const nested = (candidate as Record<string, unknown>).message
        if (typeof nested === 'string' && nested.trim()) return nested.trim().slice(0, 400)
      }
    }
  }
  return error.message || undefined
}

function probeEndpoints(baseUrl: string, type: AIProviderSummary['type']): string[] {
  const normalized = normalizeBaseUrl(baseUrl)
  if (type !== 'ollama') return [`${normalized}/models`]
  const root = normalized.replace(/\/v1$/i, '')
  const endpoints = [`${normalized}/models`, `${root}/api/tags`]
  return [...new Set(endpoints)]
}

function buildProbeHeaders(
  auth: AIProviderSummary['auth'],
  apiKey: string
): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (!apiKey || auth.type === 'none') return headers
  if (auth.type === 'bearer') headers.authorization = `Bearer ${apiKey}`
  else if (auth.type === 'x-api-key') headers['x-api-key'] = apiKey
  else headers[auth.headerName || 'authorization'] = apiKey
  return headers
}

function parseProbeModels(payload: unknown): AIModelProbeEntry[] {
  if (!payload || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const entries: AIModelProbeEntry[] = []
  const seen = new Set<string>()
  for (const item of list) {
    const id =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? String(
              (item as Record<string, unknown>).id ||
                (item as Record<string, unknown>).model ||
                (item as Record<string, unknown>).name ||
                ''
            )
          : ''
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue
    seen.add(trimmed.toLowerCase())
    const entry: AIModelProbeEntry = { id: trimmed }
    if (item && typeof item === 'object') {
      const ownedBy = (item as Record<string, unknown>).owned_by
      const created = (item as Record<string, unknown>).created
      if (typeof ownedBy === 'string' && ownedBy) entry.ownedBy = ownedBy
      if (typeof created === 'number') entry.created = created
    }
    entries.push(entry)
  }
  return entries
}

function buildHeaders(provider: AIProviderSummary, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...provider.advanced.extraHeaders
  }
  if (!apiKey || provider.auth.type === 'none') return headers
  if (provider.auth.type === 'bearer') headers.authorization = `Bearer ${apiKey}`
  else if (provider.auth.type === 'x-api-key') headers['x-api-key'] = apiKey
  else headers[provider.auth.headerName || 'authorization'] = apiKey
  return headers
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalizedName = name.toLowerCase()
  return Object.keys(headers).some((header) => header.toLowerCase() === normalizedName)
}

function requestProvider(
  provider: AIProviderSummary,
  apiKey: string,
  model: string,
  messages: AIMessage[],
  testing = false,
  signal?: AbortSignal,
  onDelta?: AIChatDeltaHandler,
  sessionId?: string
): Promise<AIRequestResult> {
  // Match the endpoint, not the editable provider name or model name.
  const url = new URL(provider.baseUrl)
  if (url.hostname === 'opencode.ai' && /^\/zen\/go(?:\/|$)/.test(url.pathname)) {
    const extraHeaders = Object.fromEntries(
      Object.entries(provider.advanced.extraHeaders).filter(
        ([name]) => name.toLowerCase() !== 'x-opencode-session'
      )
    )
    extraHeaders['x-opencode-session'] = sessionId?.trim() || randomUUID()
    if (!hasHeader(extraHeaders, 'user-agent')) extraHeaders['user-agent'] = 'TraceMemo'
    provider = { ...provider, advanced: { ...provider.advanced, extraHeaders } }
  }
  if (provider.type === 'anthropic-messages') {
    return requestAnthropic(provider, apiKey, model, messages, testing, signal)
  }
  return provider.advanced.apiProtocol === 'responses'
    ? requestOpenAIResponses(provider, apiKey, model, messages, testing, signal, onDelta)
    : requestOpenAICompatible(provider, apiKey, model, messages, testing, signal, onDelta)
}

function toOpenAIMessages(messages: AIMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map((part) =>
            part.type === 'text'
              ? { type: 'text', text: part.text }
              : { type: 'image_url', image_url: { url: part.dataUrl } }
          )
  }))
}

function openAIMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

function toOpenAIResponsesRequest(messages: AIMessage[]): {
  instructions?: string
  input: Array<{ role: string; content: unknown[] }>
} {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part) => part.type === 'text')
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('\n')
    )
    .filter(Boolean)
    .join('\n\n')
  const input = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content:
        typeof message.content === 'string'
          ? [
              {
                type: message.role === 'assistant' ? 'output_text' : 'input_text',
                text: message.content
              }
            ]
          : message.content.map((part) =>
              part.type === 'text'
                ? {
                    type: message.role === 'assistant' ? 'output_text' : 'input_text',
                    text: part.text
                  }
                : { type: 'input_image', image_url: part.dataUrl }
            )
    }))
  return { instructions: instructions || undefined, input }
}

function toAnthropicMessages(messages: AIMessage[]): Array<{ role: string; content: unknown }> {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => {
              if (part.type === 'text') return { type: 'text', text: part.text }
              const image = parseVisionImage(part.dataUrl)
              return {
                type: 'image',
                source: { type: 'base64', media_type: image.mimeType, data: image.base64 }
              }
            })
    }))
}

function modelMaxTokens(provider: AIProviderSummary, model: string): number {
  return (
    provider.models.find((item) => item.id === model)?.maxTokens ||
    provider.advanced.maxTokens ||
    4096
  )
}

async function requestOpenAICompatible(
  provider: AIProviderSummary,
  apiKey: string,
  model: string,
  messages: AIMessage[],
  testing = false,
  signal?: AbortSignal,
  onDelta?: AIChatDeltaHandler
): Promise<AIRequestResult> {
  const endpoint = provider.baseUrl.endsWith('/chat/completions')
    ? provider.baseUrl
    : `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: buildHeaders(provider, apiKey),
      body: JSON.stringify({
        model,
        messages: toOpenAIMessages(messages),
        temperature: provider.advanced.temperature,
        max_tokens: testing ? 8 : modelMaxTokens(provider, model),
        ...(provider.advanced.thinking === 'disabled' ? { thinking: { type: 'disabled' } } : {}),
        ...(provider.advanced.stream ? { stream: true } : {})
      })
    },
    provider.advanced.timeoutMs,
    signal,
    async (response) => {
      if (!response.ok) {
        const payload = await parseJsonResponse<OpenAIResponsePayload>(response)
        throw new AIProviderRequestError(
          payload.error?.message || `AI 请求失败 (${response.status})`,
          {
            status: response.status,
            code: payload.error?.code,
            type: payload.error?.type,
            responseBody: payload.error
          }
        )
      }
      if (
        provider.advanced.stream &&
        !response.headers.get('content-type')?.toLowerCase().includes('application/json')
      ) {
        return parseOpenAIStream(response, onDelta)
      }
      const payload = await parseJsonResponse<OpenAIResponsePayload>(response)
      return {
        data: openAIMessageText(payload.choices?.[0]?.message?.content),
        finishReason: String(payload.choices?.[0]?.finish_reason || 'unknown'),
        usage: toOpenAIUsage(payload.usage)
      }
    }
  )
}

async function requestOpenAIResponses(
  provider: AIProviderSummary,
  apiKey: string,
  model: string,
  messages: AIMessage[],
  testing = false,
  signal?: AbortSignal,
  onDelta?: AIChatDeltaHandler
): Promise<AIRequestResult> {
  const normalizedBaseUrl = provider.baseUrl.replace(/\/+$/, '')
  const endpoint = normalizedBaseUrl.endsWith('/responses')
    ? normalizedBaseUrl
    : normalizedBaseUrl.endsWith('/chat/completions')
      ? `${normalizedBaseUrl.slice(0, -'/chat/completions'.length)}/responses`
      : `${normalizedBaseUrl}/responses`
  const request = toOpenAIResponsesRequest(messages)
  const headers = buildHeaders(provider, apiKey)
  if (provider.advanced.stream && !hasHeader(headers, 'accept')) {
    headers.accept = 'text/event-stream'
  }
  return fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        instructions: request.instructions,
        input: request.input,
        temperature: provider.advanced.temperature,
        max_output_tokens: testing ? 128 : modelMaxTokens(provider, model),
        store: false,
        ...(provider.advanced.stream ? { stream: true } : {})
      })
    },
    provider.advanced.timeoutMs,
    signal,
    async (response) => {
      if (!response.ok) {
        const payload = await parseJsonResponse<OpenAIResponsesPayload>(response)
        throw new AIProviderRequestError(
          payload.error?.message || `AI 请求失败 (${response.status})`,
          {
            status: response.status,
            code: payload.error?.code,
            type: payload.error?.type,
            responseBody: payload.error
          }
        )
      }
      if (provider.advanced.stream) return parseOpenAIResponsesStream(response, onDelta)
      const payload = await parseJsonResponse<OpenAIResponsesPayload>(response)
      if (payload.error?.message) throw new Error(payload.error.message)
      return {
        data: extractOpenAIResponsesText(payload),
        finishReason: openAIResponsesFinishReason(payload) || 'unknown',
        usage: toOpenAIResponsesUsage(payload.usage)
      }
    }
  )
}

async function requestOpenAICompatibleWithTools(
  provider: AIProviderSummary,
  apiKey: string,
  model: string,
  messages: Array<Record<string, unknown>>,
  tools: AIChatToolDefinition[],
  signal?: AbortSignal
): Promise<{
  data: string
  toolCalls: AIChatToolCall[]
  usage?: AIRequestResult['usage']
  elapsedMs?: number
}> {
  const endpoint = provider.baseUrl.endsWith('/chat/completions')
    ? provider.baseUrl
    : `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: buildHeaders(provider, apiKey),
      body: JSON.stringify({
        model,
        messages,
        ...(tools.length ? { tools, tool_choice: 'auto' } : { tool_choice: 'none' }),
        temperature: provider.advanced.temperature,
        max_tokens: modelMaxTokens(provider, model),
        ...(provider.advanced.thinking === 'disabled' ? { thinking: { type: 'disabled' } } : {})
      })
    },
    provider.advanced.timeoutMs,
    signal,
    async (response, timing) => {
      // 先尝试解析 body：非 2xx 时上游可能返回 JSON 错误体，也可能是 HTML 错误页。
      // 无论哪种，都要把 status / content-type / elapsed 带进错误，避免丢失上下文。
      let payload: OpenAIResponsePayload | undefined
      let parseError: unknown
      try {
        payload = await parseJsonResponse<OpenAIResponsePayload>(response)
      } catch (error) {
        parseError = error
      }
      if (!response.ok) {
        throw new AIProviderRequestError(
          payload?.error?.message ||
            (parseError ? safeAIError(parseError) : `AI 请求失败 (${response.status})`),
          {
            status: timing.status,
            contentType: timing.contentType,
            elapsedMs: timing.elapsedMs,
            htmlInsteadOfJson: isHtmlParseError(parseError),
            code: payload?.error?.code,
            type: payload?.error?.type,
            responseBody: payload?.error
          }
        )
      }
      // 2xx 但 body 无法解析：抛出原始解析错误（含清晰的中文提示）。
      if (!payload) throw parseError ?? new Error('AI 响应格式异常')
      if (parseError) throw parseError
      const message = payload.choices?.[0]?.message
      return {
        data: openAIMessageText(message?.content),
        toolCalls: (message?.tool_calls || []).flatMap((call, index) => {
          const name = call.function?.name
          if (!name) return []
          return [
            {
              id: call.id || `tool-call-${index + 1}`,
              name,
              arguments: call.function?.arguments || '{}'
            }
          ]
        }),
        usage: toOpenAIUsage(payload.usage),
        elapsedMs: timing.elapsedMs
      }
    }
  )
}

async function requestAnthropic(
  provider: AIProviderSummary,
  apiKey: string,
  model: string,
  messages: AIMessage[],
  testing = false,
  signal?: AbortSignal
): Promise<AIRequestResult> {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((part) => part.type === 'text')
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('\n')
    )
    .join('\n\n')
  const anthropicMessages = toAnthropicMessages(messages)
  const headers = buildHeaders(provider, apiKey)
  if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01'
  const endpoint = provider.baseUrl.endsWith('/messages')
    ? provider.baseUrl
    : `${provider.baseUrl.replace(/\/+$/, '')}/messages`
  return fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        system: system || undefined,
        messages: anthropicMessages,
        temperature: provider.advanced.temperature,
        max_tokens: testing ? 8 : modelMaxTokens(provider, model)
      })
    },
    provider.advanced.timeoutMs,
    signal,
    async (response) => {
      const payload = await parseJsonResponse<AnthropicResponsePayload>(response)
      if (!response.ok)
        throw new AIProviderRequestError(
          payload.error?.message || `Anthropic 请求失败 (${response.status})`,
          {
            status: response.status,
            type: payload.error?.type,
            responseBody: payload.error
          }
        )
      return {
        data: Array.isArray(payload.content)
          ? payload.content
              .filter((item) => item.type === 'text')
              .map((item) => item.text || '')
              .join('\n')
          : '',
        finishReason: String(payload.stop_reason || 'unknown'),
        usage: payload.usage
          ? {
              input: payload.usage.input_tokens,
              output: payload.usage.output_tokens,
              total:
                Number(payload.usage.input_tokens || 0) + Number(payload.usage.output_tokens || 0),
              estimated: false
            }
          : undefined
      }
    }
  )
}

/** 请求级诊断：不包含任何凭据，仅用于区分「上游慢 / 上游错误 / 本地解析」。 */
interface AIRequestTiming {
  elapsedMs: number
  status: number
  contentType: string
}

async function fetchWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  consume: (response: Response, timing: AIRequestTiming) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = (): void =>
    controller.abort(signal?.reason || new DOMException('AI request cancelled', 'AbortError'))
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(
    () => {
      timedOut = true
      controller.abort(new DOMException('AI request timed out', 'TimeoutError'))
    },
    Math.max(1_000, timeoutMs || 120_000)
  )
  const startedAt = Date.now()
  let responseReceivedAt = startedAt
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    responseReceivedAt = Date.now()
    return await consume(response, {
      elapsedMs: responseReceivedAt - startedAt,
      status: response.status,
      contentType: response.headers.get('content-type') || ''
    })
  } catch (error) {
    if (signal?.aborted) throw new DOMException('AI request cancelled', 'AbortError')
    if (timedOut) throw new DOMException('AI request timed out', 'TimeoutError')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

async function parseOpenAIStream(
  response: Response,
  onDelta?: AIChatDeltaHandler
): Promise<AIRequestResult> {
  let data = ''
  let finishReason = 'unknown'
  let usage: AIRequestResult['usage']
  const stream = await readSSE(response, (eventData) => {
    let payload: OpenAIStreamPayload
    try {
      payload = JSON.parse(eventData) as OpenAIStreamPayload
    } catch {
      throw new Error('模型服务返回了无法解析的流式数据')
    }
    if (payload.error?.message) throw new Error(payload.error.message)
    if (payload.usage) usage = toOpenAIUsage(payload.usage)
    const choice = payload.choices?.[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    const delta = choice?.delta?.content
    if (typeof delta === 'string' && delta) {
      data += delta
      onDelta?.(delta)
    }
  })

  if (!stream.sawData) {
    let payload: OpenAIResponsePayload
    try {
      payload = JSON.parse(stream.rawBody) as OpenAIResponsePayload
    } catch {
      throw new Error('模型服务返回了无法解析的流式数据')
    }
    if (payload.error?.message) throw new Error(payload.error.message)
    const content = openAIMessageText(payload.choices?.[0]?.message?.content)
    if (content) onDelta?.(content)
    return {
      data: content,
      finishReason: String(payload.choices?.[0]?.finish_reason || 'unknown'),
      usage: toOpenAIUsage(payload.usage)
    }
  }
  return { data, finishReason, usage }
}

async function parseOpenAIResponsesStream(
  response: Response,
  onDelta?: AIChatDeltaHandler
): Promise<AIRequestResult> {
  let data = ''
  let completedResponse: OpenAIResponsesPayload | undefined
  let usage: AIRequestResult['usage']
  const stream = await readSSE(response, (eventData) => {
    let payload: OpenAIResponsesStreamPayload
    try {
      payload = JSON.parse(eventData) as OpenAIResponsesStreamPayload
    } catch {
      throw new Error('模型服务返回了无法解析的 Responses 流式数据')
    }
    const errorMessage = payload.error?.message || payload.response?.error?.message
    if (errorMessage) throw new Error(errorMessage)
    if (payload.response?.usage) usage = toOpenAIResponsesUsage(payload.response.usage)
    if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      data += payload.delta
      onDelta?.(payload.delta)
    }
    if (payload.type === 'response.completed') completedResponse = payload.response
    if (payload.type === 'response.failed' || payload.type === 'response.incomplete') {
      const reason = payload.response?.incomplete_details?.reason
      throw new Error(reason ? `模型响应未完成：${reason}` : payload.message || '模型响应未完成')
    }
  })

  if (!stream.sawData) {
    let payload: OpenAIResponsesPayload
    try {
      payload = JSON.parse(stream.rawBody) as OpenAIResponsesPayload
    } catch {
      throw new Error('模型服务返回了无法解析的 Responses 流式数据')
    }
    if (payload.error?.message) throw new Error(payload.error.message)
    const content = extractOpenAIResponsesText(payload)
    if (content) onDelta?.(content)
    return {
      data: content,
      finishReason: openAIResponsesFinishReason(payload) || 'unknown',
      usage: toOpenAIResponsesUsage(payload.usage)
    }
  }

  if (!data && completedResponse) {
    data = extractOpenAIResponsesText(completedResponse)
    if (data) onDelta?.(data)
  }
  return {
    data,
    finishReason: completedResponse
      ? openAIResponsesFinishReason(completedResponse) || 'unknown'
      : 'unknown',
    usage
  }
}

async function readSSE(
  response: Response,
  onEvent: (eventData: string) => void
): Promise<{ sawData: boolean; rawBody: string }> {
  if (!response.body) throw new Error('模型服务未返回可读取的流式响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let rawBody = ''
  let sawData = false
  let finished = false

  const consumeEvent = (event: string): boolean => {
    const eventData = event
      .split(/\r\n|\r|\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => {
        const value = line.slice(5)
        return value.startsWith(' ') ? value.slice(1) : value
      })
      .join('\n')
    if (!eventData) return false
    sawData = true
    rawBody = ''
    if (eventData.trim() === '[DONE]') return true
    onEvent(eventData)
    return false
  }

  const consumeBuffer = (): void => {
    while (!finished) {
      const boundary = /(?:\r\n|\r|\n){2}/.exec(buffer)
      if (!boundary) return
      const event = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      finished = consumeEvent(event)
    }
  }

  try {
    while (!finished) {
      const chunk = await reader.read()
      if (chunk.done) {
        const tail = decoder.decode()
        buffer += tail
        if (!sawData) rawBody += tail
        consumeBuffer()
        break
      }
      const text = decoder.decode(chunk.value, { stream: true })
      buffer += text
      if (!sawData) rawBody += text
      consumeBuffer()
    }
    if (!finished && buffer.trim()) finished = consumeEvent(buffer)
    if (finished) await reader.cancel().catch(() => undefined)
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }

  return { sawData, rawBody }
}

function extractOpenAIResponsesText(payload: OpenAIResponsesPayload): string {
  if (typeof payload.output_text === 'string') return payload.output_text
  return (payload.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text || '')
    .join('')
}

function openAIResponsesFinishReason(payload: OpenAIResponsesPayload): string | undefined {
  const reason = payload.incomplete_details?.reason
  if (reason === 'max_output_tokens') return 'max_tokens'
  if (reason) return reason
  if (payload.status === 'completed') return 'stop'
  if (payload.status === 'failed') return 'error'
  return undefined
}

function toOpenAIResponsesUsage(
  usage: OpenAIResponsesPayload['usage']
): AIRequestResult['usage'] | undefined {
  return usage
    ? {
        input: usage.input_tokens,
        output: usage.output_tokens,
        total: usage.total_tokens,
        estimated: false
      }
    : undefined
}

function toOpenAIUsage(
  usage: OpenAIResponsePayload['usage']
): AIRequestResult['usage'] | undefined {
  return usage
    ? {
        input: usage.prompt_tokens,
        output: usage.completion_tokens,
        total: usage.total_tokens,
        estimated: false
      }
    : undefined
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text()
  try {
    return JSON.parse(body) as T
  } catch {
    const looksLikeHtml = /^\s*(?:<!doctype\s+html|<html\b)/i.test(body)
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    if (looksLikeHtml) {
      throw new Error(`模型服务返回了网页而不是 JSON（HTTP ${status}），请稍后重试或检查中转服务`)
    }
    throw new Error(`模型服务返回格式异常（HTTP ${status}）`)
  }
}

function safeAIError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'AI 请求超时'
  if (error instanceof DOMException && error.name === 'AbortError') return 'AI 请求已取消'
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/sk-[a-z0-9_-]+/gi, '***').slice(0, 300)
}

/** 判断解析失败是否因为上游返回了 HTML（例如网关 502 错误页）。 */
function isHtmlParseError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('网页而不是 JSON')
}

function aiProviderErrorDetails(error: unknown): {
  errorCode?: string
  errorStatus?: number
  errorType?: string
} {
  if (error instanceof AIProviderRequestError) {
    return {
      ...(error.code ? { errorCode: error.code } : {}),
      ...(error.status !== undefined ? { errorStatus: error.status } : {}),
      ...(error.type ? { errorType: error.type } : {})
    }
  }
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined
  const status = Number(record?.status)
  return {
    ...(typeof record?.code === 'string' ? { errorCode: record.code } : {}),
    ...(Number.isFinite(status) && status > 0 ? { errorStatus: status } : {}),
    ...(typeof record?.type === 'string' ? { errorType: record.type } : {})
  }
}

function parseVisionImage(dataUrl: string): { mimeType: string; base64: string; bytes: number } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-z0-9+/=]+)$/i.exec(dataUrl)
  if (!match) throw new Error('图片格式不受支持，请选择 PNG、JPG、JPEG 或 WebP')
  const bytes = Buffer.byteLength(match[2], 'base64')
  return { mimeType: match[1].toLowerCase(), base64: match[2], bytes }
}

function validateVisionImage(dataUrl: string): string | undefined {
  try {
    const image = parseVisionImage(dataUrl)
    if (!image.bytes) return '图片内容为空'
    if (image.bytes > 10 * 1024 * 1024) return '图片不能超过 10 MB'
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : '图片无法读取'
  }
}

function visionFailure(error: unknown): {
  code: 'VISION_UNSUPPORTED' | 'API_ERROR'
  error: string
} {
  const message = safeAIError(error)
  const unsupported =
    /vision|multimodal|image[_ ]url|image input|image.*support|support.*image|图片.*不支持|不支持.*图片/i.test(
      message
    )
  return unsupported
    ? { code: 'VISION_UNSUPPORTED', error: '当前模型不支持图片理解' }
    : { code: 'API_ERROR', error: message || 'API 返回错误' }
}

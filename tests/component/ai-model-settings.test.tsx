import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AIImageUnderstandingTest } from '../../src/renderer/src/features/settings/ai-model/AIImageUnderstandingTest'
import { AIProviderCard } from '../../src/renderer/src/features/settings/ai-model/AIProviderCard'
import { AIModelPage } from '../../src/renderer/src/features/settings/pages/AIModelPage'
import type { AIProviderSummary, AIRuntimeModelConfig } from '../../src/shared/ai-provider'
import type { AIProviderTemplate } from '../../src/shared/ai-provider-catalog'
import type { AIVisionTestState } from '../../src/renderer/src/features/settings/ai-model/types'
import type { SystemOcrCapability } from '../../src/shared/system-ocr'

const runtime: AIRuntimeModelConfig = {
  providerName: '尚未配置',
  model: '',
  modelName: 'No model selected',
  configured: false,
  status: 'untested'
}

const systemOcrCapability: SystemOcrCapability = {
  available: true,
  engine: 'windows-system-ocr',
  platform: 'win32',
  arch: 'x64',
  runtimeVersion: '1.2.0',
  language: 'zh-Hans-CN',
  message: '本地图片文字识别可用（Windows 系统 OCR，zh-Hans-CN）。'
}

const catalog: AIProviderTemplate[] = [
  {
    id: 'relay',
    label: '中转站 / 聚合 API',
    vendor: '聚合中转',
    type: 'openai-compatible',
    baseUrl: '',
    protocol: 'chat-completions',
    models: [],
    requiresKey: true
  },
  {
    id: 'openai',
    label: 'OpenAI',
    vendor: '官方',
    type: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'chat-completions',
    models: ['gpt-4o-mini'],
    requiresKey: true
  }
]

const provider: AIProviderSummary = {
  id: 'fixture-provider',
  name: '我的中转站',
  type: 'openai-compatible',
  baseUrl: 'https://one2api.xyz/v1',
  auth: { type: 'bearer' },
  models: [
    {
      id: 'gpt-5.6-terra',
      name: 'GPT-5.6 Terra',
      capabilities: { chat: true, vision: true, ocr: true, longContext: true }
    }
  ],
  defaultModel: 'gpt-5.6-terra',
  advanced: { timeoutMs: 5000, extraHeaders: {}, apiProtocol: 'chat-completions' },
  templateId: 'relay',
  hasApiKey: true,
  isDefault: false,
  status: 'error',
  lastError: '上游拒绝了这个模型',
  lastDiagnosis: {
    code: 'MODEL_NOT_FOUND',
    message: '上游拒绝了这个模型',
    hint: '当前 API Key 所属分组没有该模型的可用渠道。',
    upstreamMessage:
      'Model "gpt-5.6-terra" is not supported by any configured account in this group'
  }
}

const visionState: AIVisionTestState = {
  status: 'ready',
  prompt: '描述图片',
  image: {
    dataUrl: 'data:image/png;base64,fixture',
    fileName: 'fixture.png',
    mimeType: 'image/png',
    size: 1024
  }
}

describe('AI model settings v2', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listAIProviders: vi.fn().mockResolvedValue({ success: true, providers: [] }),
        getAIProviderCatalog: vi.fn().mockResolvedValue(catalog),
        getAIProviderAdvisor: vi.fn().mockResolvedValue({}),
        previewAIProviderSetup: vi.fn().mockResolvedValue({ advices: [] }),
        getAIRuntimeConfig: vi.fn().mockResolvedValue(runtime),
        getSystemOcrCapability: vi.fn().mockResolvedValue(systemOcrCapability),
        saveAIProvider: vi.fn().mockResolvedValue({
          success: true,
          providers: [provider],
          defaultProviderId: provider.id
        }),
        probeAIProviderModels: vi.fn().mockResolvedValue({
          success: true,
          models: [{ id: 'deepseek-chat' }, { id: 'gpt-5.6-terra' }],
          endpoint: 'https://one2api.xyz/v1/models'
        })
      } as unknown as typeof window.api
    })
  })

  it('点「添加供应商」打开对话框，默认落到中转站模板', async () => {
    const user = userEvent.setup()
    render(<AIModelPage onRuntimeChange={vi.fn()} onNotice={vi.fn()} />)

    await act(async () => {
      await Promise.resolve()
    })
    await user.click(screen.getByRole('button', { name: '添加供应商' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '添加供应商' })).toBeInTheDocument()
    expect(screen.getByLabelText('供应商名称')).toHaveValue('中转站 / 聚合 API')
    expect(screen.getByLabelText(/Base URL/)).toHaveValue('')
    expect(screen.getByLabelText('模型 ID')).toHaveAttribute('placeholder', '例如：gpt-5.6-terra')
  })

  it('选择模板会回填名称、地址与默认模型', async () => {
    const user = userEvent.setup()
    render(<AIModelPage onRuntimeChange={vi.fn()} onNotice={vi.fn()} />)

    await act(async () => {
      await Promise.resolve()
    })
    await user.click(screen.getByRole('button', { name: '添加供应商' }))
    await user.click(screen.getByRole('button', { name: /^OpenAI/ }))

    expect(screen.getByLabelText('供应商名称')).toHaveValue('OpenAI')
    expect(screen.getByLabelText(/Base URL/)).toHaveValue('https://api.openai.com/v1')
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '默认 gpt-4o-mini' })).toBeChecked()
  })

  it('手动添加模型时不要求模型名属于已知模型族', async () => {
    const user = userEvent.setup()
    render(<AIModelPage onRuntimeChange={vi.fn()} onNotice={vi.fn()} />)

    await act(async () => {
      await Promise.resolve()
    })
    await user.click(screen.getByRole('button', { name: '添加供应商' }))
    await user.type(screen.getByLabelText('模型 ID'), 'my-relay-model-9')
    await user.click(screen.getByRole('button', { name: '添加模型' }))

    expect(screen.getByRole('radio', { name: '默认 my-relay-model-9' })).toBeChecked()
  })

  it('探测模型后可以把端点返回的模型批量加入', async () => {
    const user = userEvent.setup()
    render(<AIModelPage onRuntimeChange={vi.fn()} onNotice={vi.fn()} />)

    await act(async () => {
      await Promise.resolve()
    })
    await user.click(screen.getByRole('button', { name: '添加供应商' }))
    await user.type(screen.getByLabelText(/Base URL/), 'https://one2api.xyz/v1')
    await user.click(screen.getByRole('button', { name: '探测模型' }))

    expect(await screen.findByText('端点返回 2 个模型')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '全选' }))
    await user.click(screen.getByRole('button', { name: '添加所选（2）' }))

    expect(screen.getByRole('radio', { name: '默认 deepseek-chat' })).toBeChecked()
    expect(screen.getByText('gpt-5.6-terra')).toBeInTheDocument()
  })

  it('保存时把表单内容原样交给主进程', async () => {
    const user = userEvent.setup()
    render(<AIModelPage onRuntimeChange={vi.fn()} onNotice={vi.fn()} />)

    await act(async () => {
      await Promise.resolve()
    })
    await user.click(screen.getByRole('button', { name: '添加供应商' }))
    await user.type(screen.getByLabelText(/Base URL/), 'https://one2api.xyz/v1')
    await user.type(screen.getByLabelText('API Key'), 'sk-test')
    await user.type(screen.getByLabelText('模型 ID'), 'gpt-5.6-terra')
    await user.click(screen.getByRole('button', { name: '添加模型' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(window.api.saveAIProvider).toHaveBeenCalled())
    const payload = vi.mocked(window.api.saveAIProvider).mock.calls[0][0]
    expect(payload.baseUrl).toBe('https://one2api.xyz/v1')
    expect(payload.apiKey).toBe('sk-test')
    expect(payload.models.map((model) => model.id)).toEqual(['gpt-5.6-terra'])
    expect(payload.templateId).toBe('relay')
  })

  it('编辑已有供应商时带出原值，且不重复拉取列表', async () => {
    vi.mocked(window.api.listAIProviders).mockResolvedValue({
      success: true,
      providers: [provider]
    })
    const firstRuntimeChange = vi.fn()
    const secondRuntimeChange = vi.fn()
    const { rerender } = render(
      <AIModelPage onRuntimeChange={firstRuntimeChange} onNotice={vi.fn()} />
    )

    await act(async () => {
      await Promise.resolve()
    })
    expect(window.api.listAIProviders).toHaveBeenCalledOnce()
    expect(firstRuntimeChange).toHaveBeenCalledWith(runtime)

    await act(async () => {
      rerender(<AIModelPage onRuntimeChange={secondRuntimeChange} onNotice={vi.fn()} />)
      await Promise.resolve()
    })
    expect(window.api.listAIProviders).toHaveBeenCalledOnce()
    expect(secondRuntimeChange).not.toHaveBeenCalled()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '编辑' }))
    expect(screen.getByLabelText('供应商名称')).toHaveValue('我的中转站')
    expect(screen.getByLabelText(/Base URL/)).toHaveValue('https://one2api.xyz/v1')
    expect(screen.getByRole('radio', { name: '默认 gpt-5.6-terra' })).toBeChecked()
  })

  it('卡片展示上游原文与处理建议', () => {
    render(
      <AIProviderCard
        provider={provider}
        testing={false}
        onEdit={vi.fn()}
        onTest={vi.fn()}
        onDefault={vi.fn()}
        onDelete={vi.fn()}
      />
    )
    expect(screen.getByText(provider.lastError as string)).toBeInTheDocument()
    expect(screen.getByText(/没有该模型的可用渠道/)).toBeInTheDocument()
    expect(screen.getByText(/not supported by any configured account/)).toBeInTheDocument()
  })

  it('卡片操作按钮保持共享按钮变体', async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()
    const onTest = vi.fn()
    const onDefault = vi.fn()
    const onDelete = vi.fn()
    render(
      <AIProviderCard
        provider={provider}
        testing={false}
        onEdit={onEdit}
        onTest={onTest}
        onDefault={onDefault}
        onDelete={onDelete}
      />
    )

    await user.click(screen.getByRole('button', { name: '编辑' }))
    await user.click(screen.getByRole('button', { name: '测试连接' }))
    await user.click(screen.getByRole('button', { name: '设为默认' }))
    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(onEdit).toHaveBeenCalledOnce()
    expect(onTest).toHaveBeenCalledOnce()
    expect(onDefault).toHaveBeenCalledOnce()
    expect(onDelete).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: '删除' })).toHaveClass('bg-destructive')
  })

  it('图片理解测试保持原交互', async () => {
    const user = userEvent.setup()
    const onPromptChange = vi.fn()
    const onTest = vi.fn()
    const onClear = vi.fn()
    render(
      <AIImageUnderstandingTest
        runtime={{ ...runtime, configured: true }}
        provider={provider}
        state={visionState}
        onSelectImage={vi.fn()}
        onPromptChange={onPromptChange}
        onTest={onTest}
        onClear={onClear}
      />
    )

    expect(screen.getByRole('img', { name: '图片理解测试预览' })).toBeInTheDocument()
    expect(screen.getByLabelText('识别提示词')).toHaveValue('描述图片')
    await user.click(screen.getByRole('button', { name: '移除图片' }))
    await user.click(screen.getByRole('button', { name: '开始识别' }))
    expect(onClear).toHaveBeenCalledOnce()
    expect(onTest).toHaveBeenCalledOnce()
  })
})

import type {
  AIModelProbeEntry,
  AIProviderConfig,
  AIProviderSummary,
  AIRuntimeModelConfig,
  AIVisionTestResult
} from '../../../../../shared/ai-provider'
import type { AIProviderAdvice } from '../../../../../shared/ai-provider-advisor'
import type { AIProviderTemplate } from '../../../../../shared/ai-provider-catalog'

export const DEFAULT_VISION_PROMPT =
  '请描述这张图片中的主要内容，包括物体、场景、文字信息以及你能观察到的细节。'

export interface AIVisionTestState {
  status: 'idle' | 'reading' | 'ready' | 'testing' | 'success' | 'error'
  prompt: string
  image?: {
    dataUrl: string
    fileName: string
    mimeType: string
    size: number
  }
  result?: AIVisionTestResult
  error?: string
}

export interface ModelProbeState {
  status: 'idle' | 'loading' | 'done' | 'error'
  models: AIModelProbeEntry[]
  endpoint?: string
  error?: string
  hint?: string
}

export interface ProviderEditorState {
  open: boolean
  draft: AIProviderConfig | null
  originalId?: string
  /** 编辑已有供应商时，密钥是否已在安全存储里。 */
  hasStoredKey?: boolean
  saving: boolean
  error?: string
  advices: AIProviderAdvice[]
  probe: ModelProbeState
}

export interface AIModelSettingsState {
  loading: boolean
  providers: AIProviderSummary[]
  runtime: AIRuntimeModelConfig | null
  catalog: AIProviderTemplate[]
  testingId?: string
  error?: string
  editor: ProviderEditorState
}

export interface AIModelSettingsController {
  state: AIModelSettingsState
  openNew: (templateId?: string) => void
  openEdit: (provider: AIProviderSummary) => void
  closeEditor: () => void
  updateDraft: (patch: Partial<AIProviderConfig>) => void
  selectTemplate: (templateId: string) => void
  addModel: (modelId: string) => void
  removeModel: (modelId: string) => void
  updateModel: (modelId: string, patch: Partial<AIProviderConfig['models'][number]>) => void
  setDefaultModel: (modelId: string) => void
  probeModels: () => Promise<void>
  addProbedModels: (modelIds: string[]) => void
  save: (options?: { testAfterSave?: boolean }) => Promise<void>
  remove: (providerId: string) => Promise<void>
  setDefault: (providerId: string) => Promise<void>
  test: (providerId: string) => Promise<void>
  selectVisionImage: (file: File) => Promise<void>
  setVisionPrompt: (prompt: string) => void
  runVisionTest: () => Promise<void>
  clearVisionImage: () => void
  visionState: AIVisionTestState
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AIModelDefinition,
  AIProviderConfig,
  AIProviderSummary,
  AIRuntimeModelConfig
} from '../../../../../shared/ai-provider'
import { adviseProviderSetup } from '../../../../../shared/ai-provider-advisor'
import {
  createModelDefinition,
  createProviderDraft,
  getProviderTemplate,
  uniqueModels
} from '../../../../../shared/ai-provider-catalog'
import type {
  AIModelSettingsController,
  AIModelSettingsState,
  AIVisionTestState,
  ModelProbeState,
  ProviderEditorState
} from './types'
import { DEFAULT_VISION_PROMPT } from './types'

const emptyProbe: ModelProbeState = { status: 'idle', models: [] }

const emptyEditor: ProviderEditorState = {
  open: false,
  draft: null,
  saving: false,
  advices: [],
  probe: emptyProbe
}

const initialVision: AIVisionTestState = { status: 'idle', prompt: DEFAULT_VISION_PROMPT }

export function useAIModelSettingsController({
  onRuntimeChange,
  onNotice
}: {
  onRuntimeChange: (config: AIRuntimeModelConfig) => void
  onNotice: (message: string) => void
}): AIModelSettingsController {
  const [state, setState] = useState<AIModelSettingsState>({
    loading: true,
    providers: [],
    runtime: null,
    catalog: [],
    editor: emptyEditor
  })
  const [visionState, setVisionState] = useState<AIVisionTestState>(initialVision)
  const onRuntimeChangeRef = useRef(onRuntimeChange)

  useEffect(() => {
    onRuntimeChangeRef.current = onRuntimeChange
  }, [onRuntimeChange])

  const refresh = useCallback(async (): Promise<void> => {
    const [list, runtime] = await Promise.all([
      window.api.listAIProviders(),
      window.api.getAIRuntimeConfig()
    ])
    if (!list.success) {
      setState((current) => ({
        ...current,
        loading: false,
        error: list.error || '供应商配置读取失败'
      }))
      return
    }
    setState((current) => ({
      ...current,
      loading: false,
      error: undefined,
      providers: list.providers,
      runtime
    }))
    onRuntimeChangeRef.current(runtime)
  }, [])

  useEffect(() => {
    let active = true
    const bootstrap = async (): Promise<void> => {
      const [catalog, list, runtime] = await Promise.all([
        window.api.getAIProviderCatalog(),
        window.api.listAIProviders(),
        window.api.getAIRuntimeConfig()
      ])
      if (!active) return
      if (!list.success) {
        setState((current) => ({
          ...current,
          loading: false,
          catalog,
          error: list.error || '供应商配置读取失败'
        }))
        return
      }
      setState((current) => ({
        ...current,
        loading: false,
        catalog,
        error: undefined,
        providers: list.providers,
        runtime
      }))
      onRuntimeChangeRef.current(runtime)
    }
    void bootstrap()
    return () => {
      active = false
    }
  }, [])

  /** 建议在渲染层本地算：纯函数、无 IO，输入即刷新。 */
  const adviceFor = useCallback(
    (draft: AIProviderConfig, hasStoredKey: boolean) =>
      adviseProviderSetup({ ...draft, hasApiKey: Boolean(draft.apiKey?.trim() || hasStoredKey) })
        .advices,
    []
  )

  const openEditor = useCallback(
    (draft: AIProviderConfig, originalId: string | undefined, hasStoredKey: boolean) => {
      setState((current) => ({
        ...current,
        editor: {
          open: true,
          draft,
          originalId,
          hasStoredKey,
          saving: false,
          advices: adviceFor(draft, hasStoredKey),
          probe: emptyProbe
        }
      }))
    },
    [adviceFor]
  )

  const openNew = useCallback(
    (templateId?: string) => {
      const draft = createProviderDraft(templateId || 'relay')
      openEditor(draft, undefined, false)
    },
    [openEditor]
  )

  const openEdit = useCallback(
    (provider: AIProviderSummary) => {
      const draft: AIProviderConfig = {
        id: provider.id,
        name: provider.name,
        type: provider.type,
        baseUrl: provider.baseUrl,
        apiKey: '',
        auth: provider.auth,
        models: provider.models.map((model) => ({ ...model })),
        defaultModel: provider.defaultModel,
        advanced: { ...provider.advanced, extraHeaders: { ...provider.advanced.extraHeaders } },
        ...(provider.templateId ? { templateId: provider.templateId } : {}),
        ...(provider.note ? { note: provider.note } : {}),
        ...(provider.registryId ? { registryId: provider.registryId } : {}),
        ...(provider.group ? { group: provider.group } : {}),
        ...(provider.accountId ? { accountId: provider.accountId } : {}),
        ...(provider.supportedModels ? { supportedModels: [...provider.supportedModels] } : {}),
        ...(provider.role ? { role: provider.role } : {})
      }
      openEditor(draft, provider.id, provider.hasApiKey)
    },
    [openEditor]
  )

  const closeEditor = useCallback(() => {
    setState((current) => ({ ...current, editor: emptyEditor }))
  }, [])

  const patchEditor = useCallback(
    (updater: (editor: ProviderEditorState) => ProviderEditorState) => {
      setState((current) => {
        const next = updater(current.editor)
        const draft = next.draft
        return {
          ...current,
          editor: draft ? { ...next, advices: adviceFor(draft, Boolean(next.hasStoredKey)) } : next
        }
      })
    },
    [adviceFor]
  )

  const updateDraft = useCallback(
    (patch: Partial<AIProviderConfig>) => {
      patchEditor((editor) =>
        editor.draft
          ? { ...editor, draft: { ...editor.draft, ...patch }, error: undefined }
          : editor
      )
    },
    [patchEditor]
  )

  const selectTemplate = useCallback(
    (templateId: string) => {
      patchEditor((editor) => {
        if (!editor.draft) return editor
        const template = getProviderTemplate(templateId)
        if (!template) return editor
        const models = template.models.map((modelId) => createModelDefinition(modelId))
        const draft: AIProviderConfig = {
          ...editor.draft,
          name: template.label,
          type: template.type,
          baseUrl: template.baseUrl,
          templateId: template.id,
          auth:
            template.type === 'ollama' || !template.requiresKey
              ? { type: 'none' }
              : template.type === 'anthropic-messages'
                ? { type: 'x-api-key' }
                : { type: 'bearer' },
          advanced: { ...editor.draft.advanced, apiProtocol: template.protocol },
          models,
          defaultModel: models[0]?.id || ''
        }
        return { ...editor, draft, probe: emptyProbe, error: undefined }
      })
    },
    [patchEditor]
  )

  const addModels = useCallback(
    (modelIds: string[], detected = false) => {
      patchEditor((editor) => {
        if (!editor.draft) return editor
        const merged = uniqueModels([
          ...editor.draft.models,
          ...modelIds
            .map((id) => id.trim())
            .filter(Boolean)
            .map((id) => {
              const existing = editor.draft!.models.find(
                (model) => model.id.toLowerCase() === id.toLowerCase()
              )
              return existing ? existing : createModelDefinition(id, { detected })
            })
        ])
        const draft: AIProviderConfig = {
          ...editor.draft,
          models: merged,
          defaultModel: merged.some((model) => model.id === editor.draft!.defaultModel)
            ? editor.draft!.defaultModel
            : merged[0]?.id || ''
        }
        return { ...editor, draft, error: undefined }
      })
    },
    [patchEditor]
  )

  const addModel = useCallback((modelId: string) => addModels([modelId]), [addModels])

  const removeModel = useCallback(
    (modelId: string) => {
      patchEditor((editor) => {
        if (!editor.draft) return editor
        const models = editor.draft.models.filter((model) => model.id !== modelId)
        return {
          ...editor,
          draft: {
            ...editor.draft,
            models,
            defaultModel:
              editor.draft.defaultModel === modelId
                ? models[0]?.id || ''
                : editor.draft.defaultModel
          }
        }
      })
    },
    [patchEditor]
  )

  const updateModel = useCallback(
    (modelId: string, patch: Partial<AIModelDefinition>) => {
      patchEditor((editor) => {
        if (!editor.draft) return editor
        return {
          ...editor,
          draft: {
            ...editor.draft,
            models: editor.draft.models.map((model) =>
              model.id === modelId ? { ...model, ...patch } : model
            )
          }
        }
      })
    },
    [patchEditor]
  )

  const setDefaultModel = useCallback(
    (modelId: string) => {
      patchEditor((editor) =>
        editor.draft ? { ...editor, draft: { ...editor.draft, defaultModel: modelId } } : editor
      )
    },
    [patchEditor]
  )

  const probeModels = useCallback(async (): Promise<void> => {
    const editor = state.editor
    const draft = editor.draft
    if (!draft) return
    const hasStoredKey = Boolean(editor.hasStoredKey)
    patchEditor((current) => ({
      ...current,
      probe: { status: 'loading', models: [] }
    }))
    const result = await window.api.probeAIProviderModels({
      providerId: hasStoredKey ? editor.originalId : undefined,
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey?.trim() || undefined,
      type: draft.type
    })
    patchEditor((current) => ({
      ...current,
      probe: {
        status: result.success ? 'done' : 'error',
        models: result.models,
        endpoint: result.endpoint,
        error: result.error,
        hint: result.diagnosis?.hint
      }
    }))
  }, [patchEditor, state.editor])

  const addProbedModels = useCallback(
    (modelIds: string[]) => {
      addModels(modelIds, true)
      patchEditor((editor) => ({ ...editor, probe: emptyProbe }))
    },
    [addModels, patchEditor]
  )

  const save = useCallback(
    async (options?: { testAfterSave?: boolean }): Promise<void> => {
      const editor = state.editor
      const draft = editor.draft
      if (!draft) return
      patchEditor((current) => ({ ...current, saving: true, error: undefined }))
      const payload: AIProviderConfig = {
        ...draft,
        models: uniqueModels(draft.models)
      }
      const result = await window.api.saveAIProvider(payload)
      if (!result.success) {
        patchEditor((current) => ({
          ...current,
          saving: false,
          error: result.error || '供应商保存失败'
        }))
        return
      }
      closeEditor()
      await refresh()
      onNotice(result.notices?.length ? result.notices.join('；') : '供应商已保存')
      if (options?.testAfterSave) {
        const test = await window.api.testAIProvider(payload.id)
        await refresh()
        onNotice(
          test.success
            ? `已保存并连接成功，耗时 ${test.latencyMs || 0} ms`
            : `已保存，但连接失败：${test.error || '未知原因'}`
        )
      }
    },
    [closeEditor, onNotice, patchEditor, refresh, state.editor]
  )

  const remove = useCallback(
    async (providerId: string): Promise<void> => {
      if (!window.confirm('确认删除这个供应商？安全存储里的 API Key 也会一并清除。')) return
      const result = await window.api.deleteAIProvider(providerId)
      if (!result.success) {
        setState((current) => ({
          ...current,
          error: result.error || '供应商删除失败'
        }))
        return
      }
      await refresh()
      onNotice('供应商已删除')
    },
    [onNotice, refresh]
  )

  const setDefault = useCallback(
    async (providerId: string): Promise<void> => {
      const result = await window.api.setDefaultAIProvider(providerId)
      if (!result.success) {
        setState((current) => ({ ...current, error: result.error || '默认模型更新失败' }))
        return
      }
      await refresh()
      onNotice('默认模型已更新')
    },
    [onNotice, refresh]
  )

  const test = useCallback(
    async (providerId: string): Promise<void> => {
      setState((current) => ({ ...current, testingId: providerId }))
      const result = await window.api.testAIProvider(providerId)
      await refresh()
      setState((current) => ({ ...current, testingId: undefined }))
      const hint = result.diagnosis?.hint
      onNotice(
        result.success
          ? `连接成功，耗时 ${result.latencyMs || 0} ms`
          : [result.error || '连接测试失败', hint].filter(Boolean).join(' ')
      )
    },
    [onNotice, refresh]
  )

  const selectVisionImage = useCallback(async (file: File): Promise<void> => {
    const extension = file.name.split('.').pop()?.toLowerCase()
    const inferredType =
      extension === 'png'
        ? 'image/png'
        : extension === 'webp'
          ? 'image/webp'
          : extension === 'jpg' || extension === 'jpeg'
            ? 'image/jpeg'
            : ''
    const mimeType = file.type === 'image/jpg' ? 'image/jpeg' : file.type || inferredType
    const supportedTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
    if (!supportedTypes.has(mimeType)) {
      setVisionState((current) => ({
        ...current,
        status: 'error',
        error: '请选择 PNG、JPG、JPEG 或 WebP 图片'
      }))
      return
    }
    if (!file.size || file.size > 10 * 1024 * 1024) {
      setVisionState((current) => ({
        ...current,
        status: 'error',
        error: '图片大小必须在 10 MB 以内'
      }))
      return
    }
    setVisionState((current) => ({ ...current, status: 'reading' }))
    try {
      const rawDataUrl = await readFileAsDataUrl(file)
      const dataUrl = rawDataUrl.replace(/^data:[^;]*;/, `data:${mimeType};`)
      setVisionState((current) => ({
        ...current,
        status: 'ready',
        error: undefined,
        image: { dataUrl, fileName: file.name, mimeType, size: file.size }
      }))
    } catch {
      setVisionState((current) => ({
        ...current,
        status: 'error',
        error: '图片无法读取，请重新选择'
      }))
    }
  }, [])

  const setVisionPrompt = useCallback((prompt: string) => {
    setVisionState((current) => ({ ...current, prompt }))
  }, [])

  const runVisionTest = useCallback(async (): Promise<void> => {
    const runtime = state.runtime
    if (!runtime?.configured || !runtime.providerId || !runtime.model) {
      setVisionState((current) => ({
        ...current,
        status: 'error',
        error: '请先配置可用的默认 AI 模型'
      }))
      return
    }
    if (!visionState.image) {
      setVisionState((current) => ({ ...current, status: 'error', error: '请先选择测试图片' }))
      return
    }
    setVisionState((current) => ({ ...current, status: 'testing' }))
    try {
      const result = await window.api.testAIVision({
        providerId: runtime.providerId,
        modelId: runtime.model,
        prompt: visionState.prompt,
        imageDataUrl: visionState.image.dataUrl
      })
      setVisionState((current) => ({
        ...current,
        status: result.success ? 'success' : 'error',
        result,
        error: result.success ? undefined : result.error
      }))
      if (result.success) {
        await refresh()
        onNotice('图片理解测试成功，已更新模型能力')
      }
    } catch {
      setVisionState((current) => ({
        ...current,
        status: 'error',
        error: '图片理解测试调用失败，请稍后重试'
      }))
    }
  }, [onNotice, refresh, state.runtime, visionState.image, visionState.prompt])

  const clearVisionImage = useCallback(() => {
    setVisionState((current) => ({
      ...current,
      status: 'idle',
      image: undefined,
      result: undefined
    }))
  }, [])

  return useMemo(
    () => ({
      state,
      openNew,
      openEdit,
      closeEditor,
      updateDraft,
      selectTemplate,
      addModel,
      removeModel,
      updateModel,
      setDefaultModel,
      probeModels,
      addProbedModels,
      save,
      remove,
      setDefault,
      test,
      selectVisionImage,
      setVisionPrompt,
      runVisionTest,
      clearVisionImage,
      visionState
    }),
    [
      state,
      openNew,
      openEdit,
      closeEditor,
      updateDraft,
      selectTemplate,
      addModel,
      removeModel,
      updateModel,
      setDefaultModel,
      probeModels,
      addProbedModels,
      save,
      remove,
      setDefault,
      test,
      selectVisionImage,
      setVisionPrompt,
      runVisionTest,
      clearVisionImage,
      visionState
    ]
  )
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('invalid image'))
    )
    reader.addEventListener('error', () => reject(reader.error || new Error('read failed')))
    reader.readAsDataURL(file)
  })
}

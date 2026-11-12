import type { AIRuntimeModelConfig } from '../../../../../shared/ai-provider'
import { Button } from '../../../components/ui'
import { AIProviderCard } from '../ai-model/AIProviderCard'
import { AIProviderEditor } from '../ai-model/AIProviderEditor'
import { AIImageUnderstandingTest } from '../ai-model/AIImageUnderstandingTest'
import { LocalImageTextRecognition } from '../ai-model/LocalImageTextRecognition'
import { useAIModelSettingsController } from '../ai-model/useAIModelSettingsController'

export function AIModelPage({
  onRuntimeChange,
  onNotice
}: {
  onRuntimeChange: (config: AIRuntimeModelConfig) => void
  onNotice: (message: string) => void
}): React.ReactElement {
  const controller = useAIModelSettingsController({ onRuntimeChange, onNotice })
  const { state } = controller
  const runtime = state.runtime
  const defaultProvider = state.providers.find((provider) => provider.id === runtime?.providerId)

  return (
    <div className="settings-page ai-model-page">
      <header className="settings-page-header">
        <div>
          <h1>AI 模型</h1>
          <p>添加端点、探测模型、测试连接</p>
        </div>
        <Button onClick={() => controller.openNew()}>添加供应商</Button>
      </header>

      <div className="settings-page-scroll">
        <div className="settings-page-content ai-model-content">
          <section className="settings-card ai-model-default">
            <div>
              <span>当前默认模型</span>
              <strong>{runtime?.modelName || '尚未配置'}</strong>
              <small>
                {runtime?.providerName || '请添加供应商'}
                {runtime?.configured ? '' : ' · 未完成配置'}
              </small>
            </div>
            <div className="ai-model-default-actions">
              <span className={`settings-status-badge ${runtime?.configured ? '' : 'unavailable'}`}>
                {runtime?.configured ? '可用' : '未配置'}
              </span>
              {defaultProvider ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state.testingId === defaultProvider.id}
                  onClick={() => void controller.test(defaultProvider.id)}
                >
                  {state.testingId === defaultProvider.id ? '测试中…' : '测试连接'}
                </Button>
              ) : null}
            </div>
          </section>

          {state.error ? (
            <p className="ai-model-page-error" role="alert">
              {state.error}
            </p>
          ) : null}

          <h2 className="settings-section-heading">供应商</h2>
          <div className="ai-provider-list">
            {state.providers.map((provider) => (
              <AIProviderCard
                key={provider.id}
                provider={provider}
                testing={state.testingId === provider.id}
                onEdit={() => controller.openEdit(provider)}
                onTest={() => void controller.test(provider.id)}
                onDefault={() => void controller.setDefault(provider.id)}
                onDelete={() => void controller.remove(provider.id)}
              />
            ))}
            {!state.loading && !state.providers.length ? (
              <div className="settings-card ai-provider-empty">
                <strong>还没有供应商</strong>
                <p>点右上角「添加供应商」，先选模板，再用「探测模型」读取端点实际提供的模型。</p>
              </div>
            ) : null}
          </div>

          <AIImageUnderstandingTest
            runtime={runtime}
            provider={defaultProvider}
            state={controller.visionState}
            onSelectImage={(file) => void controller.selectVisionImage(file)}
            onPromptChange={controller.setVisionPrompt}
            onTest={() => void controller.runVisionTest()}
            onClear={controller.clearVisionImage}
          />
          <LocalImageTextRecognition />
        </div>
      </div>

      {state.editor.open && state.editor.draft ? (
        <AIProviderEditor
          draft={state.editor.draft}
          originalId={state.editor.originalId}
          hasStoredKey={state.editor.hasStoredKey}
          saving={state.editor.saving}
          error={state.editor.error}
          advices={state.editor.advices}
          probe={state.editor.probe}
          catalog={state.catalog}
          onClose={controller.closeEditor}
          onPatch={controller.updateDraft}
          onSelectTemplate={controller.selectTemplate}
          onAddModel={controller.addModel}
          onRemoveModel={controller.removeModel}
          onUpdateModel={controller.updateModel}
          onSetDefaultModel={controller.setDefaultModel}
          onProbe={() => void controller.probeModels()}
          onAddProbed={controller.addProbedModels}
          onSave={(options) => void controller.save(options)}
        />
      ) : null}
    </div>
  )
}

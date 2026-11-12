import { useMemo, useState } from 'react'
import type { AIOpenAIProtocol, AIProviderConfig } from '../../../../../shared/ai-provider'
import type { AIProviderAdvice } from '../../../../../shared/ai-provider-advisor'
import type { AIProviderTemplate } from '../../../../../shared/ai-provider-catalog'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../../components/ui'
import type { ModelProbeState } from './types'

function ProtocolSelect({
  value,
  onChange
}: {
  value: AIOpenAIProtocol | undefined
  onChange: (value: AIOpenAIProtocol) => void
}): React.ReactElement {
  return (
    <Select
      value={value || 'chat-completions'}
      onValueChange={(next) => onChange(next as AIOpenAIProtocol)}
    >
      <SelectTrigger aria-label="接口协议">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="chat-completions">
          Chat Completions（兼容 /v1/chat/completions）
        </SelectItem>
        <SelectItem value="responses">Responses API（仅 /v1/responses）</SelectItem>
      </SelectContent>
    </Select>
  )
}

function TemplatePicker({
  catalog,
  activeId,
  onSelect
}: {
  catalog: AIProviderTemplate[]
  activeId?: string
  onSelect: (id: string) => void
}): React.ReactElement {
  const groups = useMemo(() => {
    const map = new Map<string, AIProviderTemplate[]>()
    for (const template of catalog) {
      const list = map.get(template.vendor) || []
      list.push(template)
      map.set(template.vendor, list)
    }
    return [...map.entries()]
  }, [catalog])

  return (
    <section className="ai-template-picker" aria-label="供应商模板">
      {groups.map(([vendor, templates]) => (
        <div className="ai-template-group" key={vendor}>
          <span className="ai-template-vendor">{vendor}</span>
          <div className="ai-template-options">
            {templates.map((template) => (
              <button
                key={template.id}
                type="button"
                className={`ai-template-option ${activeId === template.id ? 'active' : ''}`}
                aria-pressed={activeId === template.id}
                onClick={() => onSelect(template.id)}
              >
                <strong>{template.label}</strong>
                <small>
                  {template.baseUrl ? template.baseUrl.replace(/^https?:\/\//, '') : '自定义地址'}
                </small>
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

function ProbePanel({
  probe,
  onAdd
}: {
  probe: ModelProbeState
  onAdd: (ids: string[]) => void
}): React.ReactElement | null {
  const [selected, setSelected] = useState<string[]>([])
  if (probe.status === 'idle') return null
  if (probe.status === 'loading') {
    return <p className="ai-probe-state">正在读取端点的模型列表…</p>
  }
  if (probe.status === 'error') {
    return (
      <div className="ai-probe-state error" role="alert">
        <strong>{probe.error || '读取模型失败'}</strong>
        {probe.hint ? <span>{probe.hint}</span> : null}
      </div>
    )
  }
  if (!probe.models.length) {
    return (
      <p className="ai-probe-state">
        端点没有返回模型。有些中转站不实现 /models，直接在下面手动填模型 ID。
      </p>
    )
  }
  const allSelected = selected.length === probe.models.length
  return (
    <div className="ai-probe-panel">
      <header>
        <span>
          端点返回 {probe.models.length} 个模型
          {probe.endpoint ? <code>{probe.endpoint}</code> : null}
        </span>
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(allSelected ? [] : probe.models.map((model) => model.id))}
          >
            {allSelected ? '取消全选' : '全选'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!selected.length}
            onClick={() => {
              onAdd(selected)
              setSelected([])
            }}
          >
            添加所选（{selected.length}）
          </Button>
        </div>
      </header>
      <ul>
        {probe.models.map((model) => (
          <li key={model.id}>
            <label>
              <input
                type="checkbox"
                checked={selected.includes(model.id)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, model.id]
                      : current.filter((id) => id !== model.id)
                  )
                }
              />
              <code>{model.id}</code>
              {model.ownedBy ? <small>{model.ownedBy}</small> : null}
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AIProviderEditor({
  draft,
  originalId,
  hasStoredKey,
  saving,
  error,
  advices,
  probe,
  catalog,
  onClose,
  onPatch,
  onSelectTemplate,
  onAddModel,
  onRemoveModel,
  onUpdateModel,
  onSetDefaultModel,
  onProbe,
  onAddProbed,
  onSave
}: {
  draft: AIProviderConfig
  originalId?: string
  hasStoredKey?: boolean
  saving: boolean
  error?: string
  advices: AIProviderAdvice[]
  probe: ModelProbeState
  catalog: AIProviderTemplate[]
  onClose: () => void
  onPatch: (patch: Partial<AIProviderConfig>) => void
  onSelectTemplate: (id: string) => void
  onAddModel: (id: string) => void
  onRemoveModel: (id: string) => void
  onUpdateModel: (id: string, patch: Partial<AIProviderConfig['models'][number]>) => void
  onSetDefaultModel: (id: string) => void
  onProbe: () => void
  onAddProbed: (ids: string[]) => void
  onSave: (options?: { testAfterSave?: boolean }) => void
}): React.ReactElement {
  const [modelInput, setModelInput] = useState('')
  const editing = Boolean(originalId)

  const submitModel = (): void => {
    const value = modelInput.trim()
    if (!value) return
    onAddModel(value)
    setModelInput('')
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="ai-provider-dialog max-w-4xl">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑供应商' : '添加供应商'}</DialogTitle>
          <DialogDescription>
            一个供应商就是一个端点加一组模型。保存只校验格式，能不能用由「测试连接」的真实结果决定。
          </DialogDescription>
        </DialogHeader>

        <div className="ai-provider-dialog-body">
          {!editing ? (
            <TemplatePicker
              catalog={catalog}
              activeId={draft.templateId}
              onSelect={onSelectTemplate}
            />
          ) : null}

          <section className="ai-provider-form-grid">
            <label htmlFor="ai-provider-name">
              供应商名称
              <Input
                id="ai-provider-name"
                value={draft.name}
                onChange={(event) => onPatch({ name: event.target.value })}
                placeholder="例如：我的中转站"
              />
            </label>
            <label htmlFor="ai-provider-type">
              接口类型
              <Select
                value={draft.type}
                onValueChange={(value) =>
                  onPatch({
                    type: value as AIProviderConfig['type'],
                    auth:
                      value === 'anthropic-messages'
                        ? { type: 'x-api-key' }
                        : value === 'ollama'
                          ? { type: 'none' }
                          : draft.auth.type === 'none'
                            ? { type: 'bearer' }
                            : draft.auth
                  })
                }
              >
                <SelectTrigger id="ai-provider-type" aria-label="接口类型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai-compatible">OpenAI 兼容</SelectItem>
                  <SelectItem value="anthropic-messages">Anthropic Messages</SelectItem>
                  <SelectItem value="azure-openai">Azure OpenAI</SelectItem>
                  <SelectItem value="ollama">Ollama（本地）</SelectItem>
                  <SelectItem value="custom">自定义</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="wide" htmlFor="ai-provider-base-url">
              Base URL
              <Input
                id="ai-provider-base-url"
                value={draft.baseUrl}
                onChange={(event) => onPatch({ baseUrl: event.target.value })}
                placeholder="https://your-relay.example.com/v1"
              />
              <small>填到 /v1 为止，不要带 /chat/completions。</small>
            </label>
            <label htmlFor="ai-provider-api-key">
              API Key
              <Input
                id="ai-provider-api-key"
                type="password"
                autoComplete="off"
                value={draft.apiKey || ''}
                onChange={(event) => onPatch({ apiKey: event.target.value })}
                placeholder={hasStoredKey ? '已保存，留空保持不变' : 'sk-…'}
              />
            </label>
            <label htmlFor="ai-provider-timeout">
              超时（毫秒）
              <Input
                id="ai-provider-timeout"
                type="number"
                value={draft.advanced.timeoutMs}
                onChange={(event) =>
                  onPatch({
                    advanced: { ...draft.advanced, timeoutMs: Number(event.target.value) || 120000 }
                  })
                }
              />
            </label>
            {draft.type !== 'anthropic-messages' ? (
              <label className="wide">
                接口协议
                <ProtocolSelect
                  value={draft.advanced.apiProtocol}
                  onChange={(value) =>
                    onPatch({ advanced: { ...draft.advanced, apiProtocol: value } })
                  }
                />
                <small>
                  中转站基本都是 Chat Completions；只有 /responses 的官方端点才选 Responses。
                </small>
              </label>
            ) : null}
          </section>

          <section className="ai-model-table-heading">
            <h3>模型</h3>
            <div className="ai-model-add-row">
              <Input
                aria-label="模型 ID"
                value={modelInput}
                placeholder="例如：gpt-5.6-terra"
                onChange={(event) => setModelInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    submitModel()
                  }
                }}
              />
              <Button variant="outline" size="sm" onClick={submitModel}>
                添加模型
              </Button>
              <Button variant="outline" size="sm" onClick={onProbe}>
                探测模型
              </Button>
            </div>
          </section>

          <ProbePanel probe={probe} onAdd={onAddProbed} />

          <div className="ai-model-list">
            {draft.models.map((model) => (
              <article className="ai-model-item" key={model.id}>
                <label className="ai-model-item-id">
                  <input
                    type="radio"
                    name="ai-provider-default-model"
                    aria-label={`默认 ${model.id}`}
                    checked={draft.defaultModel === model.id}
                    onChange={() => onSetDefaultModel(model.id)}
                  />
                  <code>{model.id}</code>
                </label>
                <Input
                  aria-label={`显示名 ${model.id}`}
                  value={model.name}
                  onChange={(event) => onUpdateModel(model.id, { name: event.target.value })}
                />
                <div className="ai-model-item-caps">
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`图片理解 ${model.id}`}
                      checked={model.capabilities.vision}
                      onChange={(event) => {
                        const vision = event.target.checked
                        onUpdateModel(model.id, {
                          capabilities: {
                            ...model.capabilities,
                            vision,
                            ocr: vision ? true : model.capabilities.ocr
                          }
                        })
                      }}
                    />
                    图片
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`长上下文 ${model.id}`}
                      checked={model.capabilities.longContext}
                      onChange={(event) =>
                        onUpdateModel(model.id, {
                          capabilities: {
                            ...model.capabilities,
                            longContext: event.target.checked
                          }
                        })
                      }
                    />
                    长上下文
                  </label>
                </div>
                <Button variant="ghost" size="sm" onClick={() => onRemoveModel(model.id)}>
                  移除
                </Button>
              </article>
            ))}
            {!draft.models.length ? (
              <p className="ai-model-empty">还没有模型。可以点「探测模型」从端点读取。</p>
            ) : null}
          </div>

          {advices.length ? (
            <ul className="ai-provider-advices" aria-label="配置建议">
              {advices.map((advice, index) => (
                <li key={`${advice.field}-${index}`} className={advice.level}>
                  <span>{advice.level === 'warning' ? '注意' : '提示'}</span>
                  {advice.message}
                </li>
              ))}
            </ul>
          ) : null}

          {error ? (
            <p className="ai-model-page-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="ai-provider-dialog-footer">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="outline"
            disabled={saving}
            onClick={() => onSave({ testAfterSave: true })}
          >
            {saving ? '保存中…' : '保存并测试'}
          </Button>
          <Button disabled={saving} onClick={() => onSave()}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

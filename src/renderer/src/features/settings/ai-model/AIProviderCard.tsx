import type { AIProviderSummary } from '../../../../../shared/ai-provider'
import { getProviderTemplate } from '../../../../../shared/ai-provider-catalog'
import { Button } from '../../../components/ui'

const STATUS_LABELS: Record<AIProviderSummary['status'], string> = {
  untested: '未测试',
  connected: '已连接',
  error: '连接失败'
}

function hostOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return `${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return baseUrl
  }
}

function testSummary(provider: AIProviderSummary): string {
  if (!provider.lastTestedAt) return '还没有测试过'
  const at = new Date(provider.lastTestedAt)
  return `${STATUS_LABELS[provider.status]} · ${at.toLocaleString('zh-CN', { hour12: false })}`
}

export function AIProviderCard({
  provider,
  testing,
  onEdit,
  onTest,
  onDefault,
  onDelete
}: {
  provider: AIProviderSummary
  testing: boolean
  onEdit: () => void
  onTest: () => void
  onDefault: () => void
  onDelete: () => void
}): React.ReactElement {
  const template = getProviderTemplate(provider.templateId)
  const diagnosis = provider.lastDiagnosis

  return (
    <article className="ai-provider-card">
      <header>
        <div className="ai-provider-heading">
          <h3>{provider.name}</h3>
          <div className="ai-provider-badges">
            {provider.isDefault ? <span className="ai-provider-badge default">默认</span> : null}
            <span className="ai-provider-badge">{template?.label || '自定义端点'}</span>
            {provider.role === 'strategy' ? (
              <span className="ai-provider-badge">仅策略</span>
            ) : null}
          </div>
        </div>
        <span className={`ai-provider-status ${provider.status}`}>
          {STATUS_LABELS[provider.status]}
        </span>
      </header>

      <dl>
        <div>
          <dt>端点</dt>
          <dd title={provider.baseUrl}>{hostOf(provider.baseUrl) || '未填写'}</dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd>{provider.models.length} 个</dd>
        </div>
        <div>
          <dt>默认模型</dt>
          <dd title={provider.defaultModel}>{provider.defaultModel || '未选择'}</dd>
        </div>
        <div>
          <dt>API Key</dt>
          <dd>
            {provider.hasApiKey ? '已保存' : provider.type === 'ollama' ? '无需配置' : '未配置'}
          </dd>
        </div>
      </dl>

      <p className="ai-provider-meta">
        {testSummary(provider)} · 协议{' '}
        {provider.type === 'anthropic-messages'
          ? 'Anthropic Messages'
          : provider.advanced.apiProtocol === 'responses'
            ? 'Responses API'
            : 'Chat Completions'}
      </p>

      {provider.lastError ? (
        <div className="ai-provider-error" role="status">
          <strong>{provider.lastError}</strong>
          {diagnosis?.hint ? <span>{diagnosis.hint}</span> : null}
          {diagnosis?.upstreamMessage ? (
            <code className="ai-provider-upstream">{diagnosis.upstreamMessage}</code>
          ) : null}
        </div>
      ) : null}

      <footer>
        <Button variant="outline" size="sm" onClick={onEdit}>
          编辑
        </Button>
        <Button variant="outline" size="sm" disabled={testing} onClick={onTest}>
          {testing ? '测试中…' : '测试连接'}
        </Button>
        <Button variant="outline" size="sm" disabled={provider.isDefault} onClick={onDefault}>
          设为默认
        </Button>
        <Button variant="destructive" size="sm" onClick={onDelete}>
          删除
        </Button>
      </footer>
    </article>
  )
}

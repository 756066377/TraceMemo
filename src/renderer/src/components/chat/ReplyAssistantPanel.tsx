import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Contact } from '../../../../shared/types'
import type {
  PersonalWechatSendErrorCode,
  PersonalWechatSenderStatus
} from '../../../../shared/personal-wechat'
import type {
  ReplyAssistantRequest,
  ReplyAssistantResult
} from '../../../../shared/reply-assistant'
import {
  DEFAULT_RELATIONSHIP_PROFILE,
  RELATIONSHIP_GOALS,
  RELATIONSHIP_STAGES,
  RELATIONSHIP_TYPES,
  buildRelationshipContext,
  type RelationshipProfile
} from '../../../../shared/relationship-profile'
import { Button, Input, Textarea } from '../ui'

const displayName = (contact: Contact): string =>
  contact.m_nsNickName || contact.m_nsUsrName || '未命名会话'

const AUTO_ANALYZE_DEBOUNCE_MS = 1_500
const AUTO_ANALYZE_COOLDOWN_MS = 4_000

const SEND_ERROR_HINT: Record<PersonalWechatSendErrorCode, string> = {
  invalid_input: '内容不合法：检查是否为空或超过长度限制。',
  not_ready: '发送能力未就绪：确认微信已登录，并在设置 → 微信发送 里检测通过。',
  network: '连接不上本机发送服务：检查端口与微信进程是否在运行。',
  timeout: '请求超时，消息可能已经发出。先到微信里确认，再决定是否重发。',
  hook_error: '发送服务返回错误。请先在微信核对是否已发出，再决定是否重试。',
  rate_limited: '发送过于频繁，等几秒再试。',
  unsupported_platform: '当前系统不支持个人微信发送。',
  unknown: '未知错误，可重试。'
}

interface CandidateSendState {
  status: 'sending' | 'sent' | 'error'
  error?: string
  errorCode?: PersonalWechatSendErrorCode
  attempts?: number
  segments?: number
  deliveryStatus?: 'accepted'
}

interface ReplyAssistantPanelProps {
  contact: Contact
  isGroupChat: boolean
  /** 当前会话最新一条消息，用于判断是否需要自动增量分析。 */
  latestMessage?: { id: string; createTime?: number; isSender: boolean } | null
  onClose: () => void
  onOpenPersonalWechatSettings?: () => void
}

function sendFailureText(error: string | undefined, code?: PersonalWechatSendErrorCode): string {
  const detail = String(error || '').replace(/^发送失败[:：]\s*/, '')
  const hint = code ? SEND_ERROR_HINT[code] : ''
  if (detail && hint) return `${detail} ${hint}`
  return detail || hint || '发送失败'
}

export function ReplyAssistantPanel({
  contact,
  isGroupChat,
  latestMessage,
  onClose,
  onOpenPersonalWechatSettings
}: ReplyAssistantPanelProps): React.ReactElement {
  const [profile, setProfile] = useState<RelationshipProfile | null>(null)
  const [contextSize, setContextSize] = useState(20)
  const [style, setStyle] = useState('')
  const [replyTo, setReplyTo] = useState('')
  const [result, setResult] = useState<ReplyAssistantResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasStarted, setHasStarted] = useState(false)
  const [autoAnalyze, setAutoAnalyze] = useState(true)
  const [rankCandidates, setRankCandidates] = useState(true)
  const [autoStatus, setAutoStatus] = useState<string>('')
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editedText, setEditedText] = useState('')
  const [sendStates, setSendStates] = useState<Record<number, CandidateSendState>>({})
  const [sendStatus, setSendStatus] = useState<PersonalWechatSenderStatus | null>(null)
  const [sendStatusLoading, setSendStatusLoading] = useState(false)
  const latestMessageId = latestMessage?.id

  const inFlightRef = useRef(false)
  const pendingAutoRef = useRef(false)
  const lastRunAtRef = useRef(0)
  const lastSignatureRef = useRef('')
  /** 已排期但还没执行的消息签名；避免每次重渲染都重置 debounce。 */
  const scheduledSignatureRef = useRef('')
  const runAnalysisRef = useRef<((mode: 'manual' | 'auto') => Promise<void>) | null>(null)
  const epochRef = useRef(0)
  const autoTimersRef = useRef(new Set<number>())
  const autoEnabledRef = useRef(autoAnalyze)
  const profileRef = useRef<RelationshipProfile | null>(null)

  const clearAutoTimers = useCallback((): void => {
    for (const timer of autoTimersRef.current) window.clearTimeout(timer)
    autoTimersRef.current.clear()
    pendingAutoRef.current = false
  }, [])

  useEffect(() => {
    autoEnabledRef.current = autoAnalyze
    if (!autoAnalyze) clearAutoTimers()
  }, [autoAnalyze, clearAutoTimers])

  const queueAutoAnalysis = useCallback((delay: number): void => {
    const epoch = epochRef.current
    const timer = window.setTimeout(() => {
      autoTimersRef.current.delete(timer)
      if (epoch !== epochRef.current || !autoEnabledRef.current) return
      pendingAutoRef.current = false
      void runAnalysisRef.current?.('auto')
    }, delay)
    autoTimersRef.current.add(timer)
  }, [])

  // 切换会话：清空结果与自动分析状态，重新读关系档案。
  useEffect(() => {
    setResult(null)
    setProfile(null)
    profileRef.current = null
    setError(null)
    setHasStarted(false)
    setAutoStatus('')
    setCopiedIndex(null)
    setEditingIndex(null)
    setSendStates({})
    lastSignatureRef.current = ''
    lastRunAtRef.current = 0
    scheduledSignatureRef.current = ''
    inFlightRef.current = false
    setLoading(false)
    let active = true
    void window.api
      .getRelationshipProfile?.(contact.md5)
      .then((next) => {
        if (active && next) setProfile(next)
      })
      .catch(() => undefined)
    return () => {
      active = false
      epochRef.current += 1
      clearAutoTimers()
    }
  }, [contact.md5, clearAutoTimers])

  const refreshSendStatus = useCallback(async (): Promise<void> => {
    setSendStatusLoading(true)
    try {
      const next = await window.api.getPersonalWechatSenderStatus?.()
      if (next) setSendStatus(next)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '微信发送能力检测失败')
    } finally {
      setSendStatusLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshSendStatus()
  }, [refreshSendStatus])

  useEffect(() => {
    profileRef.current = profile
  }, [profile])

  const saveProfile = useCallback(
    (patch: Partial<RelationshipProfile>): void => {
      const base =
        (profileRef.current?.userMd5 === contact.md5 ? profileRef.current : null) ||
        ({
          ...DEFAULT_RELATIONSHIP_PROFILE,
          userMd5: contact.md5,
          updatedAt: Date.now()
        } satisfies RelationshipProfile)
      const next: RelationshipProfile = { ...base, ...patch, userMd5: contact.md5 }
      profileRef.current = next
      setProfile(next)
      // 副作用放在 updater 外面：避免 StrictMode 双调用导致重复写入。
      void window.api
        .saveRelationshipProfile?.({
          userMd5: contact.md5,
          type: next.type,
          stage: next.stage,
          goal: next.goal,
          note: next.note
        })
        .catch(() => undefined)
    },
    [contact.md5]
  )

  const runAnalysis = useCallback(
    async (mode: 'manual' | 'auto'): Promise<void> => {
      if (inFlightRef.current) {
        if (mode === 'auto') pendingAutoRef.current = true
        return
      }
      inFlightRef.current = true
      const epoch = epochRef.current
      if (mode === 'manual') {
        clearAutoTimers()
        if (latestMessageId) lastSignatureRef.current = `${contact.md5}:${latestMessageId}`
      }
      setLoading(true)
      setError(null)
      setCopiedIndex(null)
      setEditingIndex(null)
      setSendStates({})
      if (mode === 'auto') setAutoStatus('检测到新消息，正在自动分析…')
      lastRunAtRef.current = Date.now()
      try {
        const request: ReplyAssistantRequest = {
          userMd5: contact.md5,
          contextSize,
          isGroupChat,
          rankCandidates,
          ...(profile
            ? {
                relationshipType: profile.type,
                relationshipStage: profile.stage,
                relationshipGoal: profile.goal,
                relationshipNote: profile.note
              }
            : {}),
          style: style.trim(),
          ...(isGroupChat && replyTo.trim() ? { replyTo: replyTo.trim() } : {})
        }
        const next = await window.api.analyzeReply(request)
        if (epoch !== epochRef.current) return
        setResult(next)
        if (!next.success) {
          setError(next.error || `分析失败（${next.code || 'unknown'}）`)
        }
        setHasStarted(true)
        if (mode === 'auto') {
          setAutoStatus(
            next.success
              ? `已按最新消息自动更新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
              : '自动分析失败，可点「重新分析」重试'
          )
        }
      } catch (caught) {
        if (epoch !== epochRef.current) return
        setError(caught instanceof Error ? caught.message : String(caught))
        if (mode === 'auto') setAutoStatus('自动分析失败，可点「重新分析」重试')
      } finally {
        if (epoch === epochRef.current) {
          inFlightRef.current = false
          setLoading(false)
          if (pendingAutoRef.current && autoEnabledRef.current) {
            pendingAutoRef.current = false
            const wait = Math.max(0, AUTO_ANALYZE_COOLDOWN_MS - (Date.now() - lastRunAtRef.current))
            queueAutoAnalysis(wait)
          }
        }
      }
    },
    [
      contact.md5,
      contextSize,
      isGroupChat,
      profile,
      replyTo,
      style,
      rankCandidates,
      latestMessageId,
      clearAutoTimers,
      queueAutoAnalysis
    ]
  )

  useEffect(() => {
    runAnalysisRef.current = runAnalysis
  }, [runAnalysis])

  /**
   * 自动增量分析：只在「已经手动分析过一次」后生效，
   * 且只对对方的新消息触发，避免自己发完消息又跑一遍。
   */
  useEffect(() => {
    if (!hasStarted || !autoAnalyze) return
    const latest = latestMessage
    if (!latest?.id) return
    const signature = `${contact.md5}:${latest.id}`
    if (signature === lastSignatureRef.current) return
    // 定时器还没触发时，重复渲染不应该重置 debounce，也不应该重新排期。
    if (signature === scheduledSignatureRef.current) return
    if (latest.isSender) {
      lastSignatureRef.current = signature
      return
    }
    scheduledSignatureRef.current = signature
    const timer = window.setTimeout(() => {
      if (signature === lastSignatureRef.current) {
        scheduledSignatureRef.current = ''
        return
      }
      lastSignatureRef.current = signature
      scheduledSignatureRef.current = ''
      const wait = Math.max(0, AUTO_ANALYZE_COOLDOWN_MS - (Date.now() - lastRunAtRef.current))
      if (wait > 0) {
        // 手动分析刚跑完：等冷却结束再自动跑，别在同一条消息上连打两次模型。
        pendingAutoRef.current = true
        queueAutoAnalysis(wait + 50)
        return
      }
      void runAnalysisRef.current?.('auto')
    }, AUTO_ANALYZE_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      if (scheduledSignatureRef.current === signature) scheduledSignatureRef.current = ''
    }
  }, [autoAnalyze, contact.md5, hasStarted, latestMessage, queueAutoAnalysis])

  const handleCopy = useCallback(async (text: string, index: number): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIndex(index)
    } catch {
      setError('复制失败，请手动选中候选文字复制')
    }
  }, [])

  const handleSend = useCallback(
    async (text: string, index: number): Promise<void> => {
      const current = sendStates[index]
      if (current?.status === 'sending' || current?.status === 'sent') return
      const content = text.trim()
      if (!content) return
      if (!sendStatus?.canSendText) {
        setSendStates((states) => ({
          ...states,
          [index]: { status: 'error', error: '微信发送能力未就绪', errorCode: 'not_ready' }
        }))
        return
      }
      setSendStates((states) => ({ ...states, [index]: { status: 'sending' } }))
      try {
        const response = await window.api.sendPersonalWechatMessage({
          type: 'text',
          to: contact.m_nsUsrName,
          isGroup: isGroupChat,
          text: content
        })
        if (response.status) setSendStatus(response.status)
        if (!response.success) {
          setSendStates((states) => ({
            ...states,
            [index]: {
              status: 'error',
              error: sendFailureText(response.error, response.errorCode),
              errorCode: response.errorCode,
              attempts: response.attempts
            }
          }))
          return
        }
        setSendStates((states) => ({
          ...states,
          [index]: {
            status: 'sent',
            attempts: response.attempts,
            segments: response.segments,
            deliveryStatus: response.deliveryStatus
          }
        }))
        setEditingIndex(null)
      } catch (caught) {
        setSendStates((states) => ({
          ...states,
          [index]: {
            status: 'error',
            error: sendFailureText(
              caught instanceof Error ? caught.message : String(caught),
              'unknown'
            ),
            errorCode: 'unknown'
          }
        }))
      }
    },
    [contact.m_nsUsrName, isGroupChat, sendStates, sendStatus]
  )

  const relationshipSummary = useMemo(() => buildRelationshipContext(profile), [profile])
  const canSendText = Boolean(sendStatus?.canSendText)
  const sendStatusText = sendStatusLoading
    ? '正在检测微信发送能力…'
    : canSendText
      ? '微信发送已就绪'
      : sendStatus?.message || '微信发送未就绪，请先在设置 → 微信发送完成配置'

  return (
    <aside className="reply-panel" aria-label="分析与回复草稿">
      <header className="reply-panel-header">
        <div>
          <h2>分析与回复草稿</h2>
          <p>{displayName(contact)}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          收起
        </Button>
      </header>

      <div className="reply-panel-body">
        <section className="reply-panel-card">
          <div className="reply-panel-section-head">
            <h3>关系与目标</h3>
            <span>{relationshipSummary || '未设置'}</span>
          </div>
          <div className="reply-panel-grid">
            <label>
              关系类型
              <select
                aria-label="关系类型"
                value={profile?.type || DEFAULT_RELATIONSHIP_PROFILE.type}
                onChange={(event) =>
                  saveProfile({ type: event.target.value as RelationshipProfile['type'] })
                }
              >
                {RELATIONSHIP_TYPES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              关系阶段
              <select
                aria-label="关系阶段"
                value={profile?.stage || DEFAULT_RELATIONSHIP_PROFILE.stage}
                onChange={(event) =>
                  saveProfile({ stage: event.target.value as RelationshipProfile['stage'] })
                }
              >
                {RELATIONSHIP_STAGES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              本轮目标
              <select
                aria-label="本轮目标"
                value={profile?.goal || DEFAULT_RELATIONSHIP_PROFILE.goal}
                onChange={(event) =>
                  saveProfile({ goal: event.target.value as RelationshipProfile['goal'] })
                }
              >
                {RELATIONSHIP_GOALS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="reply-panel-note">
            补充说明（可选）
            <Input
              aria-label="补充说明"
              value={profile?.note || ''}
              maxLength={200}
              placeholder="一句话补充，例如：上周刚一起吃过饭"
              onChange={(event) => saveProfile({ note: event.target.value })}
            />
          </label>
        </section>

        <section className="reply-panel-card">
          <div className="reply-panel-grid">
            <label>
              参考最近消息数
              <select
                aria-label="参考最近消息数"
                value={contextSize}
                onChange={(event) => setContextSize(Number(event.target.value))}
              >
                <option value={10}>10 条</option>
                <option value={20}>20 条</option>
                <option value={30}>30 条</option>
              </select>
            </label>
            {isGroupChat ? (
              <label>
                指定回复对象（可选）
                <Input
                  aria-label="指定回复对象"
                  value={replyTo}
                  maxLength={60}
                  placeholder="群成员显示名"
                  onChange={(event) => setReplyTo(event.target.value)}
                />
              </label>
            ) : null}
            <label className="wide">
              口吻描述（可选）
              <Textarea
                aria-label="口吻描述"
                value={style}
                maxLength={200}
                rows={2}
                placeholder="例如：短句、少用标点；留空则从我自己说过的话里取样"
                onChange={(event) => setStyle(event.target.value)}
              />
            </label>
          </div>
          <div className="reply-panel-actions">
            <label className="reply-panel-toggle">
              <input
                type="checkbox"
                aria-label="自动分析新消息"
                checked={autoAnalyze}
                onChange={(event) => setAutoAnalyze(event.target.checked)}
              />
              分析后自动跟踪新消息
            </label>
            <Button type="button" onClick={() => void runAnalysis('manual')} disabled={loading}>
              {loading ? '分析中…' : hasStarted ? '重新分析' : '开始分析'}
            </Button>
          </div>
          <label className="reply-panel-toggle">
            <input
              type="checkbox"
              aria-label="比较候选回复"
              checked={rankCandidates}
              onChange={(event) => setRankCandidates(event.target.checked)}
            />
            比较候选回复
          </label>
          <p className="reply-panel-hint">
            {hasStarted
              ? autoStatus ||
                (autoAnalyze ? '已开启自动分析：对方发来新消息会自动更新' : '自动分析已关闭')
              : '首次需要手动点一次「开始分析」；之后在聊天窗口里会持续自动分析新消息。'}
          </p>
        </section>

        {error ? (
          <div role="alert" className="reply-panel-error">
            {error}
          </div>
        ) : null}

        {result?.success ? (
          <>
            <section className="reply-panel-card">
              <div className="reply-panel-chips">
                <span>来源：本地微信数据库</span>
                <span>
                  已用 {result.messageCount}/{result.contextSize} 条
                </span>
                {result.provider ? (
                  <span>
                    {result.provider.providerName} · {result.provider.model}
                  </span>
                ) : null}
              </div>

              {result.blocked ? (
                <div className="reply-panel-blocked">
                  <strong>对方已明确要求停止联系，本轮不生成候选。</strong>
                  <p>{result.brief.nextStep}</p>
                </div>
              ) : null}

              <h3>对话分析</h3>
              <div className="reply-panel-facts">
                <span>可见原文</span>
                <ul className="dui-list">
                  {result.strategy?.evidence?.length ? (
                    result.strategy.evidence.map((evidence, index) => (
                      <li className="dui-list-row p-0" key={`${evidence.messageId}-${index}`}>
                        <div className="min-w-0 [overflow-wrap:anywhere]">
                          <span>
                            {evidence.speaker}：「{evidence.quote}」
                          </span>
                          <div className="reply-panel-hint">
                            {evidence.timestamp ? (
                              <time dateTime={new Date(evidence.timestamp).toISOString()}>
                                {new Date(evidence.timestamp).toLocaleString('zh-CN', {
                                  hour12: false
                                })}
                              </time>
                            ) : (
                              '时间未知'
                            )}
                          </div>
                        </div>
                      </li>
                    ))
                  ) : result.brief.facts.length ? (
                    result.brief.facts.map((fact, index) => (
                      <li key={`${index}-${fact}`}>{fact}</li>
                    ))
                  ) : (
                    <li>暂无可引用原文</li>
                  )}
                </ul>
              </div>
              <dl className="reply-panel-brief">
                <div>
                  <dt>可能意图</dt>
                  <dd>{result.brief.intent}</dd>
                </div>
                <div>
                  <dt>模型估计</dt>
                  <dd>
                    {result.brief.intentConfidence === null
                      ? '不可用'
                      : `${Math.round(result.brief.intentConfidence * 100)}%（不是真实概率）`}
                  </dd>
                </div>
                <div>
                  <dt>建议动作</dt>
                  <dd>{result.brief.action}</dd>
                </div>
                <div>
                  <dt>仍未知</dt>
                  <dd>{result.brief.unknown}</dd>
                </div>
                <div>
                  <dt>下一步</dt>
                  <dd>{result.brief.nextStep}</dd>
                </div>
                <div>
                  <dt>停止条件</dt>
                  <dd>{result.brief.stopCondition}</dd>
                </div>
              </dl>
              {result.knowledge ? (
                <div className="reply-panel-facts">
                  <span>本轮参考资料</span>
                  {result.knowledge.sources.length ? (
                    <ul>
                      {result.knowledge.sources.map((source) => (
                        <li key={source.id}>{source.title}</li>
                      ))}
                    </ul>
                  ) : null}
                  {result.knowledge.status !== 'loaded' ? (
                    <p className="reply-panel-hint" role="status">
                      {result.knowledge.status === 'partial'
                        ? '部分参考资料不可用，本轮已使用可用资料与基础规则。'
                        : '参考资料暂不可用，本轮仅按基础规则分析。'}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <p className="reply-panel-hint">{result.brief.evidenceNote}</p>
            </section>

            {result.candidates.length ? (
              <section className="reply-panel-card">
                <div className="reply-panel-section-head">
                  <h3>回复草稿</h3>
                  <span className={canSendText ? '' : 'warn'}>{sendStatusText}</span>
                </div>
                <div className="reply-panel-send-tools">
                  {!canSendText && onOpenPersonalWechatSettings ? (
                    <Button variant="outline" size="sm" onClick={onOpenPersonalWechatSettings}>
                      打开微信发送设置
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void refreshSendStatus()}
                    disabled={sendStatusLoading}
                  >
                    {sendStatusLoading ? '检测中…' : '重新检测'}
                  </Button>
                </div>

                {result.candidates.map((candidate, index) => {
                  const state = sendStates[index]
                  const editing = editingIndex === index
                  const text = editing ? editedText : candidate
                  return (
                    <article className="reply-candidate" key={`${index}-${candidate}`}>
                      {editing ? (
                        <Textarea
                          aria-label={`编辑候选 ${index + 1}`}
                          value={editedText}
                          rows={3}
                          onChange={(event) => setEditedText(event.target.value)}
                        />
                      ) : (
                        <p className="reply-candidate-text">{candidate}</p>
                      )}
                      <p className="reply-candidate-meta">
                        {index === result.bestIndex ? '本轮相对推荐' : '候选'}
                        {result.scoreMethod === 'model_relative_weights'
                          ? ` · 相对权重 ${Math.round((result.scores[index] || 0) * 100)}%（不是回复成功率）`
                          : ' · 未评出优先顺序'}
                        {state?.status === 'sent'
                          ? ` · ${state.deliveryStatus === 'accepted' ? '已提交微信，送达待确认' : '已发送'}${state.segments && state.segments > 1 ? `（${state.segments} 段）` : ''}`
                          : state?.attempts && state.attempts > 1
                            ? ` · 重试 ${state.attempts - 1} 次`
                            : ''}
                      </p>
                      {state?.status === 'error' ? (
                        <p className="reply-candidate-error" role="alert">
                          {state.error}
                        </p>
                      ) : null}
                      <div className="reply-candidate-actions">
                        {editing ? (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setEditingIndex(null)
                                setEditedText('')
                              }}
                            >
                              取消编辑
                            </Button>
                            <Button
                              size="sm"
                              disabled={!editedText.trim() || state?.status === 'sending'}
                              aria-label={`发送编辑后的候选 ${index + 1} 到微信`}
                              onClick={() => void handleSend(editedText, index)}
                            >
                              发送编辑后的内容
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={`复制候选 ${index + 1}`}
                              onClick={() => void handleCopy(candidate, index)}
                            >
                              {copiedIndex === index ? '已复制' : '复制'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`编辑候选 ${index + 1}`}
                              onClick={() => {
                                setEditingIndex(index)
                                setEditedText(candidate)
                              }}
                            >
                              编辑
                            </Button>
                            <Button
                              size="sm"
                              aria-label={`发送候选 ${index + 1} 到微信`}
                              disabled={
                                !canSendText ||
                                state?.status === 'sending' ||
                                state?.status === 'sent'
                              }
                              onClick={() => void handleSend(text, index)}
                            >
                              {state?.status === 'sent'
                                ? state.deliveryStatus === 'accepted'
                                  ? '已提交'
                                  : '已发送'
                                : state?.status === 'sending'
                                  ? '发送中…'
                                  : state?.status === 'error'
                                    ? '重试发送'
                                    : '发送到微信'}
                            </Button>
                          </>
                        )}
                      </div>
                    </article>
                  )
                })}
                <p className="reply-panel-hint">
                  发送始终由你决定；这里不会自动发送。长文本会自动按句子拆成多条发送。
                </p>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </aside>
  )
}

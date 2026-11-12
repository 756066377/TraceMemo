import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type {
  PersonalWechatSendCapability,
  PersonalWechatSenderStatus,
  WechatHookComponentStatus
} from '../../../../../shared/personal-wechat'
import { WECHAT_HOOK_COMPATIBLE_VERSION } from '../../../../../shared/personal-wechat'
import { Button, GlassCard, Input, Skeleton } from '../../../components/ui'
import { PersonalWechatSetupGuide } from '../../../components/chat/PersonalWechatSetupGuide'
import { isMac, isWindows } from '../../../utils/runtime-environment'

const capabilityLabel: Record<PersonalWechatSendCapability['status'], string> = {
  unsupported: '暂不支持',
  unconfigured: '尚未配置',
  needs_binding: '需要绑定',
  initializing: '初始化中',
  ready: '已就绪',
  error: '异常'
}

function normalizeWindowsPort(value: string): string | null {
  const text = value.trim()
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? String(port) : null
}

function boundToCurrentWechat(status: PersonalWechatSenderStatus | null): boolean {
  if (!status) return false
  return (
    status.state === 'online' ||
    Boolean(
      status.wechatPid &&
      status.boundWechatPid === status.wechatPid &&
      status.attachReady &&
      status.baseAddressReady
    )
  )
}

function formatBytes(size: number): string {
  if (size <= 0) return '0 B'
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function PersonalWechatSendPage({
  onNotice,
  onOpenTextToSpeechSettings
}: {
  onNotice: (message: string) => void
  onOpenTextToSpeechSettings?: () => void
}): ReactElement {
  const [capability, setCapability] = useState<PersonalWechatSendCapability | null>(null)
  const [senderStatus, setSenderStatus] = useState<PersonalWechatSenderStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [binding, setBinding] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState('')
  const [windowsSenderStatus, setWindowsSenderStatus] = useState<PersonalWechatSenderStatus | null>(
    null
  )
  const [windowsPortInput, setWindowsPortInput] = useState('')
  const [windowsSavedPort, setWindowsSavedPort] = useState('')
  const [windowsDetectedPort, setWindowsDetectedPort] = useState('')
  const [windowsEndpointBusy, setWindowsEndpointBusy] = useState(false)
  const [scanningEndpoint, setScanningEndpoint] = useState(false)
  const [scanSummary, setScanSummary] = useState('')
  const [hookStatus, setHookStatus] = useState<WechatHookComponentStatus | null>(null)
  const [hookBusy, setHookBusy] = useState(false)
  const [hookMessage, setHookMessage] = useState('')
  const [forceInject, setForceInject] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    if (isWindows) {
      try {
        const settingsResult = await window.api.getSettings()
        const configuredPort = String(settingsResult.settings.windowsWechatPort || '').trim()
        setWindowsSavedPort(configuredPort)
        setWindowsPortInput(configuredPort)
        if (configuredPort) {
          setWindowsSenderStatus(await window.api.getPersonalWechatSenderStatus())
        }
      } catch (reason) {
        setWindowsSenderStatus(null)
        setError(reason instanceof Error ? reason.message : '微信发送能力状态读取失败')
      } finally {
        setLoading(false)
      }
      return
    }
    try {
      const [nextCapability, nextSender] = await Promise.all([
        window.api.getPersonalWechatSendCapability(),
        window.api.getPersonalWechatSenderStatus()
      ])
      setCapability(nextCapability)
      setSenderStatus(nextSender)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '微信发送能力读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isWindows) return
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (isWindows || !senderStatus || senderStatus.canSend || senderStatus.state === 'error') {
      return undefined
    }
    if (!boundToCurrentWechat(senderStatus)) return undefined
    const timer = window.setInterval(() => void refresh(), 1_000)
    return () => window.clearInterval(timer)
  }, [refresh, senderStatus])

  /** Windows：读取已保存端口对应的发送状态与 Hook 组件状态。 */
  useEffect(() => {
    if (!isWindows) return
    void refresh()
  }, [refresh])

  const loadHookStatus = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.getWechatHookComponentStatus?.()
      if (next) setHookStatus(next)
    } catch {
      // 组件状态读不到不影响端口配置。
    }
  }, [])

  useEffect(() => {
    // isWindows 在模块生命周期内恒定，只依赖加载函数即可。
    if (!isWindows) return
    void loadHookStatus()
  }, [loadHookStatus])

  useEffect(() => {
    if (!isWindows || !windowsSenderStatus?.endpointReady || windowsSenderStatus.canSend) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await window.api.checkPersonalWechatSenderStatus(windowsPortInput)
        if (cancelled) return
        setWindowsSenderStatus(next)
        if (next.canSend || !next.endpointReady) return
      } catch {
        if (cancelled) return
      }
      timer = setTimeout(() => void poll(), 2_000)
    }
    timer = setTimeout(() => void poll(), 2_000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [windowsPortInput, windowsSenderStatus?.endpointReady, windowsSenderStatus?.canSend])

  const bindWechat = async (): Promise<void> => {
    if (binding) return
    setBinding(true)
    setError('')
    try {
      const nextStatus = await window.api.rebindPersonalWechatSender()
      setSenderStatus(nextStatus)
      const nextCapability = await window.api.getPersonalWechatSendCapability()
      setCapability(nextCapability)
      if (nextStatus.state === 'error' && nextStatus.message) setError(nextStatus.message)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '个人微信绑定失败')
    } finally {
      setBinding(false)
    }
  }

  const detectCapability = async (): Promise<void> => {
    if (isWindows) {
      await detectWindowsEndpoint()
      return
    }
    if (detecting) return
    setDetecting(true)
    try {
      await refresh()
    } finally {
      setDetecting(false)
    }
  }

  const normalizedWindowsPort = normalizeWindowsPort(windowsPortInput)
  const windowsCanSave = Boolean(
    normalizedWindowsPort &&
    normalizedWindowsPort === windowsDetectedPort &&
    windowsSenderStatus?.endpointReady
  )

  const handleWindowsPortInput = (value: string): void => {
    setWindowsPortInput(value)
    setWindowsDetectedPort('')
    setWindowsSenderStatus(null)
  }

  const detectWindowsEndpoint = async (): Promise<void> => {
    if (windowsEndpointBusy) return
    if (!normalizedWindowsPort) {
      onNotice('请输入 1 到 65535 之间的微信发送能力端口')
      return
    }
    setWindowsEndpointBusy(true)
    setError('')
    setWindowsDetectedPort('')
    try {
      const nextStatus = await window.api.checkPersonalWechatSenderStatus(normalizedWindowsPort)
      setWindowsSenderStatus(nextStatus)
      if (nextStatus.endpointReady) {
        setWindowsDetectedPort(normalizedWindowsPort)
        onNotice(
          nextStatus.canSend
            ? '已检测到微信发送能力，请点击保存'
            : nextStatus.loginState === 'logged_out'
              ? '发送接口已连接，可以保存端口；请先登录微信'
              : nextStatus.loginState === 'logged_in'
                ? '接口连接和登录正常，但发送已暂停，请查看原因'
                : '发送接口已连接，可以保存端口；组件尚未确认登录，发送暂不可用'
        )
      } else {
        onNotice(nextStatus.error || nextStatus.message || '未检测到微信发送能力')
      }
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : '微信发送能力检测失败')
    } finally {
      setWindowsEndpointBusy(false)
    }
  }

  /** 扫描本机端口：只做只读探测，找到就自动填入并检测，不自动保存。 */
  const scanWindowsEndpoint = async (): Promise<void> => {
    if (scanningEndpoint || windowsEndpointBusy) return
    setScanningEndpoint(true)
    setScanSummary('')
    setError('')
    try {
      const result = await window.api.scanPersonalWechatEndpoint()
      if (!result.success) {
        setScanSummary(result.error || '扫描失败')
        return
      }
      if (result.bestPort) {
        setWindowsPortInput(result.bestPort)
        setWindowsDetectedPort('')
        const status = await window.api.checkPersonalWechatSenderStatus(result.bestPort)
        setWindowsSenderStatus(status)
        const matched = result.candidates.find((item) => item.port === result.bestPort)
        const protocolText = matched?.protocolLabel ? `（${matched.protocolLabel}）` : ''
        const loginText = status.canSend
          ? ''
          : status.loginState === 'logged_out'
            ? '，微信尚未登录'
            : status.loginState === 'logged_in'
              ? '，微信已登录，发送已暂停'
              : '，组件尚未确认登录'
        if (status.endpointReady) {
          setWindowsDetectedPort(result.bestPort)
          setScanSummary(
            status.canSend
              ? `端口 ${result.bestPort} 可用${protocolText}，点「保存」启用。`
              : `端口 ${result.bestPort} 已连接${protocolText}${loginText}，可以保存；发送暂不可用。`
          )
        } else {
          setScanSummary(
            `端口 ${result.bestPort} 有响应${protocolText}${loginText}，但还不可发送：${status.message || status.error || '未知原因'}`
          )
        }
        return
      }
      const responded = result.candidates.filter((item) => item.status)
      setScanSummary(
        responded.length
          ? `扫了 ${result.scanned} 个端口，没有找到发送接口（${responded.length} 个端口有响应，但都不符合已知契约）。`
          : `扫了 ${result.scanned} 个端口，没有找到发送接口。微信 4.1.15.56 请先退出微信，再点「启动微信并连接」。`
      )
    } catch (reason) {
      setScanSummary(reason instanceof Error ? reason.message : '扫描本机端口失败')
    } finally {
      setScanningEndpoint(false)
    }
  }

  const saveWindowsEndpoint = async (): Promise<void> => {
    if (windowsEndpointBusy || !windowsCanSave || !normalizedWindowsPort) return
    setWindowsEndpointBusy(true)
    try {
      await window.api.setSettings({ windowsWechatPort: normalizedWindowsPort })
      setWindowsDetectedPort('')
      await refresh()
      onNotice('微信发送能力端口已保存')
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : '微信发送能力端口保存失败')
    } finally {
      setWindowsEndpointBusy(false)
    }
  }

  const clearWindowsEndpoint = async (): Promise<void> => {
    if (windowsEndpointBusy || !windowsPortInput.trim()) return
    setWindowsEndpointBusy(true)
    setError('')
    try {
      await window.api.setSettings({ windowsWechatPort: '' })
      // 清除后直接重置本地状态，不再 refresh：refresh 会重新读回配置，
      // 若后端仍返回旧值（缓存或写入延迟）会把刚清空的输入框又填回去。
      setWindowsPortInput('')
      setWindowsSavedPort('')
      setWindowsDetectedPort('')
      setWindowsSenderStatus(null)
      setScanSummary('')
      onNotice('微信发送能力端口已清除')
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : '微信发送能力端口清除失败')
    } finally {
      setWindowsEndpointBusy(false)
    }
  }

  const importHookDll = async (): Promise<void> => {
    if (hookBusy) return
    setHookBusy(true)
    setHookMessage('')
    try {
      const result = await window.api.importWechatHookDll?.()
      if (!result || result.canceled) return
      if (!result.success) {
        setHookMessage(result.error || '导入失败')
        return
      }
      await loadHookStatus()
      onNotice('Hook 组件已导入')
    } finally {
      setHookBusy(false)
    }
  }

  const injectHook = async (force: boolean): Promise<void> => {
    if (hookBusy) return
    setHookBusy(true)
    setHookMessage('')
    try {
      const current = await window.api.getWechatHookComponentStatus?.()
      if (current?.wechat.running) {
        const closed = await window.api.closeWechatForHook?.()
        if (!closed?.success) {
          setHookMessage(closed?.error || '微信还在运行，请手动退出后再注入')
          return
        }
      }
      const result = await window.api.installWechatHook?.({ force })
      if (!result) return
      setHookMessage(
        result.success ? result.steps.join('；') || '已注入' : result.error || '注入失败'
      )
      if (result.success) {
        onNotice('Hook 组件已注入，重启微信后生效')
        setForceInject(false)
        // 注入完成后自动探测一次端口，省掉手动扫描。
        window.setTimeout(() => void scanWindowsEndpoint(), 600)
      }
    } finally {
      setHookBusy(false)
      await loadHookStatus()
    }
  }

  /** 没有可用组件时：选一次文件就完成「导入 + 关闭微信 + 写入微信目录」。 */
  const pickAndInjectHook = async (force: boolean): Promise<void> => {
    if (hookBusy) return
    setHookBusy(true)
    setHookMessage('')
    try {
      const result = await window.api.pickAndInjectWechatHook?.({ force })
      if (!result || result.canceled) return
      setHookMessage(
        result.success ? result.steps.join('；') || '已注入' : result.error || '注入失败'
      )
      if (result.success) {
        onNotice('Hook 组件已注入，重启微信后生效')
        setForceInject(false)
        // 注入完成后自动探测一次端口，省掉手动扫描。
        window.setTimeout(() => void scanWindowsEndpoint(), 600)
      }
    } catch (reason) {
      setHookMessage(reason instanceof Error ? reason.message : '注入失败')
    } finally {
      setHookBusy(false)
      await loadHookStatus()
    }
  }

  /** 注入到正在运行的微信进程：微信 4.1.15+ 不再加载安装目录里的 version.dll，只能进程内注入。 */
  const injectRunningWechat = async (): Promise<void> => {
    if (hookBusy) return
    setHookBusy(true)
    setHookMessage('')
    try {
      const result = await window.api.injectRunningWechatHook?.({ force: forceInject })
      if (!result) return
      setHookMessage(result.success ? result.steps.join('；') : result.error || '注入失败')
      if (!result.success) return
      onNotice('Hook 已注入运行中的微信')
      if (result.port) {
        setWindowsPortInput(result.port)
        const nextStatus = await window.api.checkPersonalWechatSenderStatus(result.port)
        setWindowsSenderStatus(nextStatus)
        if (nextStatus.endpointReady) setWindowsDetectedPort(result.port)
      }
    } catch (reason) {
      setHookMessage(reason instanceof Error ? reason.message : '注入失败')
    } finally {
      setHookBusy(false)
      await loadHookStatus()
    }
  }

  const startWechatWithHook = async (): Promise<void> => {
    if (hookBusy) return
    setHookBusy(true)
    setHookMessage('')
    try {
      const result = await window.api.startWechatWithHook()
      setHookMessage(result.success ? result.steps.join('；') : result.error || '启动失败')
      if (result.success && result.port) {
        setWindowsPortInput(result.port)
        const next = await window.api.checkPersonalWechatSenderStatus(result.port)
        setWindowsSenderStatus(next)
        if (next.endpointReady) setWindowsDetectedPort(result.port)
        onNotice(
          next.canSend
            ? '微信发送接口已连接'
            : next.loginState === 'logged_out'
              ? '接口已连接，请先登录微信'
              : next.loginState === 'logged_in'
                ? '接口连接和登录正常，但发送已暂停，请查看原因'
                : '接口已连接，组件尚未确认登录'
        )
      }
    } catch (reason) {
      setHookMessage(reason instanceof Error ? reason.message : '启动失败')
    } finally {
      setHookBusy(false)
      await loadHookStatus()
    }
  }

  const uninstallHook = async (): Promise<void> => {
    if (hookBusy) return
    setHookBusy(true)
    setHookMessage('')
    try {
      const result = await window.api.uninstallWechatHook?.()
      if (!result) return
      setHookMessage(
        result.success ? result.steps.join('；') || '已卸载' : result.error || '卸载失败'
      )
      if (result.success) onNotice('Hook 组件已从微信目录移除')
    } finally {
      setHookBusy(false)
      await loadHookStatus()
    }
  }

  const ready = Boolean(capability?.ready)
  const pageReady = isWindows ? Boolean(windowsSenderStatus?.canSend) : ready
  const pageCapabilities = isWindows
    ? {
        text: Boolean(windowsSenderStatus?.canSendText),
        image: Boolean(windowsSenderStatus?.canSendImage),
        voice: Boolean(windowsSenderStatus?.canSendVoice)
      }
    : capability?.capabilities || { text: false, image: false, voice: false }
  const pageMessage = isWindows
    ? windowsSenderStatus?.message || '请输入端口并检测 Windows 微信发送能力'
    : capability?.message || '微信发送能力暂不可用'
  const macUnavailable = isMac && senderStatus?.state === 'runtime_missing'
  const pageStatus = capability?.status || (isWindows && pageReady ? 'ready' : 'unconfigured')

  const hookInstalled = Boolean(hookStatus?.installed)
  const hookVersionOk = Boolean(hookStatus?.versionSupported)
  const hookRunning = Boolean(hookStatus?.wechat.running)
  const hookHasDll = Boolean(hookStatus?.dll)
  const legacyHook = hookStatus?.wechat.version === '4.1.10.27'
  const channelLabel = !windowsPortInput
    ? '未配置'
    : windowsCanSave && normalizedWindowsPort !== normalizeWindowsPort(windowsSavedPort)
      ? '待保存'
      : windowsSenderStatus?.canSend
        ? '已就绪'
        : windowsSenderStatus?.endpointReady
          ? windowsSenderStatus.loginState === 'logged_in'
            ? '已连接 · 发送已暂停'
            : windowsSenderStatus.loginState === 'logged_out'
              ? '已连接 · 微信未登录'
              : '已连接 · 登录未确认'
          : '待检测'

  return (
    <div className="settings-page personal-wechat-send-page">
      <header className="settings-page-header">
        <div>
          <h1>微信发送</h1>
          <p>
            {isWindows
              ? `仅适配 Windows 微信 ${WECHAT_HOOK_COMPATIBLE_VERSION}。管理日报、档案与回复草稿的发送通道。`
              : '管理个人微信消息发送能力，日报、档案和回复草稿发送都会使用这里的状态。'}
          </p>
        </div>
        <div className="wechat-send-header-actions">
          <span className={`dui-badge dui-badge-outline ${pageReady ? 'dui-badge-success' : ''}`}>
            {loading
              ? '检测中'
              : isWindows
                ? channelLabel
                : macUnavailable
                  ? '暂不可用'
                  : capabilityLabel[pageStatus]}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || detecting || windowsEndpointBusy || scanningEndpoint}
            onClick={() => void detectCapability()}
          >
            {detecting || windowsEndpointBusy ? '刷新中…' : '刷新状态'}
          </Button>
        </div>
      </header>

      <div className="settings-page-scroll">
        <div className="settings-page-content">
          {loading && !capability && !isWindows ? (
            <Skeleton className="h-28 w-full" />
          ) : (
            <>
              {isWindows ? (
                <>
                  <section className="wechat-send-overview" aria-label="发送状态概览">
                    <dl className="wechat-send-overview-grid">
                      <div>
                        <dt>发送通道</dt>
                        <dd>{channelLabel}</dd>
                        <dd className="wechat-send-overview-note">
                          {windowsSenderStatus?.hookProtocolLabel ||
                            (windowsPortInput ? `端口 ${windowsPortInput}` : '未选择端口')}
                        </dd>
                      </div>
                      <div>
                        <dt>微信</dt>
                        <dd>{hookStatus?.wechat.version || '未检测到'}</dd>
                        <dd className="wechat-send-overview-note">
                          {hookRunning
                            ? '运行中'
                            : hookStatus?.wechat.detected
                              ? '未运行'
                              : '未安装或未找到'}
                        </dd>
                      </div>
                      <div>
                        <dt>Hook 组件</dt>
                        <dd>{hookInstalled ? '已注入' : hookHasDll ? '已导入' : '未安装'}</dd>
                        <dd className="wechat-send-overview-note">
                          {hookStatus?.dll
                            ? `${hookStatus.dll.machine.toUpperCase()} · ${formatBytes(hookStatus.dll.size)}`
                            : '安装包未内置，可手动导入'}
                        </dd>
                      </div>
                    </dl>
                  </section>

                  <div className="wechat-send-layout">
                    <div className="wechat-send-main">
                      <GlassCard
                        title="端口与连接"
                        description="连接本机发送服务，检测成功后保存端口。"
                        className="wechat-send-section"
                      >
                        <div className="wechat-send-port-row">
                          <label className="wechat-send-port-field" htmlFor="wechat-send-port">
                            <span>本机服务端口</span>
                            <Input
                              id="wechat-send-port"
                              aria-label="微信发送能力端口"
                              aria-describedby="wechat-send-port-hint wechat-send-connection-status"
                              className="wechat-send-port-input"
                              type="number"
                              min={1}
                              max={65535}
                              inputMode="numeric"
                              placeholder="端口号"
                              value={windowsPortInput}
                              disabled={windowsEndpointBusy}
                              onChange={(event) => handleWindowsPortInput(event.target.value)}
                            />
                          </label>
                          <div className="wechat-send-port-actions">
                            <Button
                              size="sm"
                              variant="default"
                              disabled={windowsEndpointBusy}
                              onClick={() =>
                                void (windowsCanSave
                                  ? saveWindowsEndpoint()
                                  : detectWindowsEndpoint())
                              }
                            >
                              {windowsEndpointBusy
                                ? windowsCanSave
                                  ? '保存中…'
                                  : '检测中…'
                                : windowsCanSave
                                  ? '保存'
                                  : '检测'}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={scanningEndpoint || windowsEndpointBusy}
                              onClick={() => void scanWindowsEndpoint()}
                            >
                              {scanningEndpoint ? '扫描中…' : '扫描本机端口'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={windowsEndpointBusy || !windowsPortInput.trim()}
                              onClick={() => void clearWindowsEndpoint()}
                            >
                              清除端口
                            </Button>
                          </div>
                        </div>
                        <p
                          id="wechat-send-connection-status"
                          className="wechat-send-status-line"
                          role="status"
                          aria-live="polite"
                          aria-atomic="true"
                        >
                          {scanSummary || windowsSenderStatus?.message || pageMessage}
                        </p>
                        {error ? (
                          <p className="wechat-send-error" role="alert">
                            {error}
                          </p>
                        ) : null}
                        <p id="wechat-send-port-hint" className="wechat-send-hint">
                          端口来自本机另装的发送 hook（wxhelper 19088 / wcf-http 9999 / WeChat-Hook
                          30001）；扫描会按协议自动识别。
                        </p>
                      </GlassCard>

                      <GlassCard
                        title="Hook 组件"
                        description={`仅适配微信 ${WECHAT_HOOK_COMPATIBLE_VERSION}，请先核对当前版本。`}
                        className="wechat-send-section"
                      >
                        <div className="wechat-hook-version">
                          <span className="dui-badge dui-badge-outline">
                            仅适配 {WECHAT_HOOK_COMPATIBLE_VERSION}
                          </span>
                          <span className="wechat-send-hint">
                            {hookStatus?.wechat.version
                              ? hookStatus.wechat.version === WECHAT_HOOK_COMPATIBLE_VERSION
                                ? '当前微信版本匹配'
                                : `当前 ${hookStatus.wechat.version}，版本不匹配`
                              : '尚未检测到微信版本'}
                          </span>
                        </div>
                        <dl className="wechat-hook-facts">
                          <div>
                            <dt>当前微信</dt>
                            <dd>{hookStatus?.wechat.version || '未检测到'}</dd>
                          </div>
                          <div>
                            <dt>适用微信版本</dt>
                            <dd>{WECHAT_HOOK_COMPATIBLE_VERSION}</dd>
                          </div>
                          <div>
                            <dt>组件声明版本</dt>
                            <dd>
                              {hookStatus?.dll
                                ? hookStatus.dll.wechatVersions.length
                                  ? hookStatus.dll.wechatVersions
                                      .map((version) => (version === '*' ? '未声明' : version))
                                      .join('、')
                                  : '未声明'
                                : hookStatus?.supportedVersions.join('、') || '未声明'}
                            </dd>
                          </div>
                          <div>
                            <dt>组件状态</dt>
                            <dd>
                              {hookStatus?.dll
                                ? `${hookStatus.dll.source === 'bundled' ? '安装包内置' : '手动导入'} · ${hookStatus.dll.machine.toUpperCase()}`
                                : '无组件'}
                            </dd>
                          </div>
                          <div>
                            <dt>组件来源</dt>
                            <dd title={hookStatus?.dll?.origin || hookStatus?.dll?.path}>
                              {hookStatus?.dll?.origin
                                ? hookStatus.dll.origin.replace(/^https:\/\//, '')
                                : hookStatus?.dll?.path
                                  ? '手动导入'
                                  : '—'}
                            </dd>
                          </div>
                          <div>
                            <dt>{legacyHook ? '微信目录' : '启动方式'}</dt>
                            <dd title={hookStatus?.wechat.installDir}>
                              {!legacyHook
                                ? '配套启动器'
                                : hookStatus?.installedMatchesComponent
                                  ? '已写入 version.dll'
                                  : hookStatus?.installed
                                    ? '存在其他 version.dll'
                                    : '未写入'}
                            </dd>
                          </div>
                        </dl>

                        {hookStatus && hookStatus.reasons.length ? (
                          <ul className="wechat-hook-reasons">
                            {hookStatus.reasons.map((reason) => (
                              <li key={reason}>{reason}</li>
                            ))}
                          </ul>
                        ) : null}

                        {hookMessage ? (
                          <p className="wechat-send-status-line" role="status">
                            {hookMessage}
                          </p>
                        ) : null}

                        <div className="wechat-hook-actions">
                          {!legacyHook ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={hookBusy || !hookVersionOk}
                              onClick={() => void startWechatWithHook()}
                            >
                              {hookBusy ? '启动中…' : '启动微信并连接'}
                            </Button>
                          ) : (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={
                                  hookBusy || (hookHasDll && !hookVersionOk && !forceInject)
                                }
                                onClick={() =>
                                  void (hookHasDll
                                    ? injectHook(forceInject)
                                    : pickAndInjectHook(forceInject))
                                }
                              >
                                {hookBusy
                                  ? '处理中…'
                                  : !hookHasDll
                                    ? '选择 DLL 并注入'
                                    : hookRunning
                                      ? '关闭微信并注入'
                                      : '注入到微信'}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={hookBusy}
                                onClick={() => void injectRunningWechat()}
                              >
                                注入到运行中的微信
                              </Button>
                            </>
                          )}
                        </div>
                        <p className="wechat-send-hint">
                          请先手动退出微信，再启动并登录。文字、群聊文字和图片可用；语音和正式 @
                          提醒暂不支持。 提交成功不代表送达，请以微信客户端为准。
                        </p>
                        {legacyHook || hookInstalled ? (
                          <div className="wechat-hook-maintenance">
                            <span className="wechat-send-group-label">组件管理</span>
                            <div className="wechat-hook-actions">
                              {legacyHook ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={hookBusy}
                                  onClick={() => void importHookDll()}
                                >
                                  仅保存 DLL
                                </Button>
                              ) : null}
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={hookBusy || !hookInstalled}
                                onClick={() => void uninstallHook()}
                              >
                                卸载组件
                              </Button>
                            </div>
                          </div>
                        ) : null}
                        <div className="wechat-hook-resources">
                          <span className="wechat-send-group-label">下载与适配</span>
                          <div className="wechat-hook-actions">
                            {legacyHook ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={hookBusy}
                                onClick={() => void window.api.openWechatHookReleasePage?.()}
                              >
                                打开组件下载页
                              </Button>
                            ) : null}
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={hookBusy}
                              onClick={() => void window.api.openWechatHookWechatDownload?.()}
                            >
                              查看适配说明
                            </Button>
                          </div>
                        </div>
                        {legacyHook && !hookVersionOk ? (
                          <label className="wechat-hook-force">
                            <input
                              className="dui-checkbox dui-checkbox-sm"
                              type="checkbox"
                              checked={forceInject}
                              onChange={(event) => setForceInject(event.target.checked)}
                            />
                            版本不匹配也强制尝试
                          </label>
                        ) : null}

                        <div className="wechat-hook-compatibility">
                          <h3>版本与注入方式</h3>
                          <p className="wechat-send-hint">
                            配套启动器仅适配微信 {WECHAT_HOOK_COMPATIBLE_VERSION} x64。
                            更新微信后需要重新核对组件版本。导入其他 DLL 不代表已完成适配；
                            新版请使用配套启动器，直接重启微信不会加载发送组件。
                          </p>
                        </div>
                      </GlassCard>
                    </div>

                    <GlassCard
                      title="可用能力"
                      description="日报、档案和回复草稿共享此通道。"
                      className="wechat-send-section wechat-send-capability-panel"
                    >
                      <div className="wechat-send-capabilities" aria-label="微信发送能力明细">
                        {(
                          [
                            ['文字', pageCapabilities.text],
                            ['图片', pageCapabilities.image],
                            ['语音', pageCapabilities.voice]
                          ] as const
                        ).map(([label, available]) => (
                          <div key={label} className="wechat-send-capability">
                            <span>{label}</span>
                            <span
                              className={`dui-badge dui-badge-sm dui-badge-outline ${available ? 'dui-badge-success' : ''}`}
                            >
                              {available ? '可发送' : '未就绪'}
                            </span>
                          </div>
                        ))}
                      </div>
                      <p className="wechat-send-hint">能力状态会随端口检测结果更新。</p>
                      <details className="dui-collapse dui-collapse-arrow wechat-send-details">
                        <summary className="dui-collapse-title">接口契约与替代方案</summary>
                        <div className="dui-collapse-content">
                          <ul>
                            <li>
                              <strong>TraceMemo Hook</strong>：<code>/getLoginInfo</code> +{' '}
                              <code>/SendMsg</code>
                            </li>
                            <li>
                              <strong>wxhelper</strong>（19088）：
                              <code>/api/checkLogin</code> + <code>/api/sendTextMsg</code>
                            </li>
                            <li>
                              <strong>wcf-http</strong>（9999）：<code>/login</code> +{' '}
                              <code>/text</code>
                            </li>
                            <li>
                              <strong>WeChat-Hook 4.x</strong>（30001）：
                              <code>/QueryDB/status</code> + <code>/SendTextMsg</code>
                            </li>
                          </ul>
                          <p>以上为可识别的接口协议，不扩大微信版本适配范围。</p>
                          <p>
                            没有可用通道时，自动发送不可用；仍可在「分析并起草」面板里点
                            <strong>复制</strong>候选，到微信窗口粘贴发送。
                          </p>
                        </div>
                      </details>
                    </GlassCard>
                  </div>
                </>
              ) : null}

              {!isMac && !isWindows ? (
                <>
                  <h2 className="settings-section-heading">发送能力</h2>
                  <section className="settings-card">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <span className="settings-card-kicker">个人微信</span>
                        <strong className="mt-1 block text-base">{pageMessage}</strong>
                        <p className="mt-2 text-sm text-muted-foreground">
                          微信消息发送目前仅支持 macOS 和 Windows。
                        </p>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => void detectCapability()}>
                        {detecting ? '刷新中…' : '刷新状态'}
                      </Button>
                    </div>
                    {error ? (
                      <p className="mt-3 text-sm text-destructive" role="alert">
                        {error}
                      </p>
                    ) : null}
                  </section>
                </>
              ) : null}

              {isMac ? (
                <>
                  <h2 className="settings-section-heading">配置状态</h2>
                  <PersonalWechatSetupGuide
                    senderStatus={senderStatus}
                    binding={binding}
                    detecting={detecting}
                    sessionBound={boundToCurrentWechat(senderStatus)}
                    onBind={() => void bindWechat()}
                    onStartSending={() =>
                      onNotice('微信消息发送能力已就绪，请在狗头军师中选择会话开始发送。')
                    }
                    onOpenTextToSpeechSettings={onOpenTextToSpeechSettings}
                  />
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

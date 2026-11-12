export type PersonalWechatSenderState =
  | 'checking'
  | 'unsupported_platform'
  | 'wechat_not_running'
  | 'sip_enabled'
  | 'unsupported_version'
  | 'runtime_missing'
  | 'hook_not_ready'
  | 'stopped'
  | 'starting'
  | 'rebinding'
  | 'online'
  | 'error'

/** 已适配的微信发送接口协议；实际探测结果会写进 status。 */
export type WechatHookProtocolId = 'trace-hook' | 'wxhelper' | 'wcf-http' | 'wechat4-hook'

export interface PersonalWechatSenderStatus {
  state: PersonalWechatSenderState
  platform: string
  arch: string
  sipDisabled: boolean
  wechatRunning: boolean
  wechatPid?: number
  boundWechatPid?: number
  endpoint: string
  endpointReady: boolean
  wechatVersion?: string
  runtimeReady: boolean
  executablePath?: string
  configPath?: string
  imagePath?: string
  attachReady: boolean
  baseAddress?: string
  baseAddressReady: boolean
  textHookInstalled: boolean
  textHookReady: boolean
  imageHookInstalled: boolean
  imageHookReady: boolean
  messageListenerReady: boolean
  canSend: boolean
  canSendText: boolean
  canSendImage: boolean
  canSendVoice: boolean
  /** 自动探测到的 hook 协议；未探测到时不设置。 */
  hookProtocol?: WechatHookProtocolId
  hookProtocolLabel?: string
  loginState?: 'logged_in' | 'logged_out' | 'unknown'
  message: string
  error?: string
}

/** Stable, feature-facing send capability derived from the low-level sender status. */
export type PersonalWechatSendCapabilityState =
  | 'unsupported'
  | 'unconfigured'
  | 'needs_binding'
  | 'initializing'
  | 'ready'
  | 'error'

export interface PersonalWechatSendCapability {
  supported: boolean
  ready: boolean
  status: PersonalWechatSendCapabilityState
  capabilities: {
    text: boolean
    image: boolean
    voice: boolean
  }
  senderStatus: PersonalWechatSenderStatus
  message: string
  error?: string
}

interface PersonalWechatSendBaseRequest {
  to: string
  isGroup: boolean
}

export interface PersonalWechatSendTextRequest extends PersonalWechatSendBaseRequest {
  type: 'text'
  text: string
}

export interface PersonalWechatSendImageRequest extends PersonalWechatSendBaseRequest {
  type: 'image'
  filePath: string
  /** 日报图片成功后再发送的文字；undefined 表示普通图片发送，不启用日报序列。 */
  postfixText?: string
}

export interface PersonalWechatSendVoiceRequest extends PersonalWechatSendBaseRequest {
  type: 'voice'
  filePath: string
  /** Internal comparison switch for the temporary voice regression test. */
  voiceSendMode?: 'normalized' | 'legacy'
  fromId?: string
  durationMs?: number
}

export type PersonalWechatSendRequest =
  | PersonalWechatSendTextRequest
  | PersonalWechatSendImageRequest
  | PersonalWechatSendVoiceRequest

/** Renderer 请求发送刚刚生成的 TTS 语音；Action 元数据由主进程补齐。 */
export interface PersonalWechatGeneratedTtsVoiceRequest {
  to: string
  isGroup: boolean
  filePath: string
}

export interface PersonalWechatGeneratedTtsVoiceResult {
  action: import('./wechat-action').WechatActionResult
  status: PersonalWechatSenderStatus
}

export type PersonalWechatSendErrorCode =
  | 'invalid_input'
  | 'not_ready'
  | 'network'
  | 'timeout'
  | 'hook_error'
  | 'rate_limited'
  | 'unsupported_platform'
  | 'unknown'

/** 本机端口扫描：用于自动找到微信发送接口所在的端口。 */
export interface PersonalWechatEndpointCandidate {
  port: string
  matched: boolean
  status?: number
  detail?: string
  /** 命中的 hook 协议，扫描时可一并告诉用户。 */
  protocol?: WechatHookProtocolId
  protocolLabel?: string
  /** hook 报告的登录态；false 表示接口在但微信未登录。 */
  loggedIn?: boolean
}

export interface PersonalWechatEndpointScanResult {
  success: boolean
  scanned: number
  candidates: PersonalWechatEndpointCandidate[]
  /** 命中接口契约的端口（可直接填进设置页）。 */
  bestPort?: string
  error?: string
}

/**
 * 配套启动器对应的微信版本。硬编码 RVA 必须严格匹配小版本。
 */
export const WECHAT_HOOK_COMPATIBLE_VERSION = '4.1.15.56'
/** 旧版目录代理的历史下载地址；新版设置入口只打开本地适配说明。 */
export const WECHAT_HOOK_COMPATIBLE_DOWNLOAD_URL =
  'https://github.com/aixed/WeChat-Hook/releases/download/v4.1.10.27/WeChatWin_4.1.10.27.exe'

/** Hook 组件（version.dll 代理）信息。 */
export interface WechatHookDllInfo {
  path: string
  size: number
  sha256: string
  machine: 'x64' | 'x86' | 'unknown'
  source: 'bundled' | 'imported'
  /** 组件声明适用的微信版本；'*' 表示未声明版本，注入前需要用户确认。 */
  wechatVersions: string[]
  /** 内置组件的下载地址，便于核对来源。 */
  origin?: string
}

export interface WechatHookComponentStatus {
  platform: string
  wechat: {
    detected: boolean
    version?: string
    installDir?: string
    executablePath?: string
    processName?: string
    running: boolean
  }
  dll?: WechatHookDllInfo
  installed: boolean
  installedMatchesComponent: boolean
  backupExists: boolean
  supportedVersions: string[]
  versionSupported: boolean
  canInject: boolean
  reasons: string[]
}

export interface WechatHookInstallResult {
  success: boolean
  error?: string
  needsWechatClosed?: boolean
  steps: string[]
  port?: string
  loggedIn?: boolean
}

export interface PersonalWechatSendResult {
  success: boolean
  /** 接口只确认提交到微信内部通道，不能据此确认送达。 */
  deliveryStatus?: 'accepted'
  status: PersonalWechatSenderStatus
  error?: string
  /** 结构化的失败原因，界面据此给不同处理建议。 */
  errorCode?: PersonalWechatSendErrorCode
  /** 实际请求次数（含首次）；>1 说明发生过自动重试。 */
  attempts?: number
  /** 文字被拆成几段发送（长文本场景）。 */
  segments?: number
  /** 已成功发出的段数；中途失败时小于 segments。 */
  sentSegments?: number
  postfixSent?: boolean
  postfixError?: string
}

export const DEFAULT_REPORT_IMAGE_POSTFIX_TEXT = '今日日报'

/** Safe, user-copyable metadata for the most recent voice send attempt. */
export interface PersonalWechatVoiceDiagnostic {
  request_id: string
  voice_id: string
  phase: 'prepared' | 'completed' | 'failed'
  encoder_name: string
  encoder_version: string
  input_bytes?: number
  normalized_input_bytes?: number
  pcm_size?: number
  sample_rate?: number
  channels?: number
  input_duration_ms?: number
  upload_result?: string
  upload_data_len?: number
  silk_duration_ms?: number
  send_result?: string
  voice_send_mode?: 'normalized' | 'legacy'
  failure_phase?: string
  error?: string
}

export interface PersonalWechatImageSelectionResult {
  canceled: boolean
  path?: string
  name?: string
}

export type PersonalWechatVoiceSelectionResult = PersonalWechatImageSelectionResult

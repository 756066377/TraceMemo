import { execFile } from 'child_process'
import { createHash, randomBytes, randomUUID } from 'crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { homedir, tmpdir } from 'os'
import { delimiter, dirname, extname, join, sep } from 'path'
import { resolveBundledFfmpegPath } from '../ffmpeg-path'
import { promisify } from 'util'
import type {
  PersonalWechatEndpointCandidate,
  PersonalWechatEndpointScanResult,
  PersonalWechatSendErrorCode,
  PersonalWechatSendRequest,
  PersonalWechatSendResult,
  PersonalWechatSenderStatus,
  PersonalWechatVoiceDiagnostic
} from '../../shared/personal-wechat'
import { loadSettings } from './settings-store'
import { SilkAudioDecoder, SilkAudioEncoder } from '../voice-pipeline/audio-decoder'
import { appLogger } from '../app-logger'
import { accountDirectoryBelongsToIdentity, readLocalAccountIdentity } from './local-account-identity'
import { macWechatRuntimeManager } from './mac-wechat-runtime-manager'
import {
  HOOK_PROTOCOL_LABELS,
  WECHAT4_SEND_SUSPENDED_REASON,
  HookCallError,
  hookSupportsVoice,
  probeHook,
  sendImageViaHook,
  sendTextViaHook,
  type WechatHookProtocol
} from './windows-wechat-hook'

const execFileAsync = promisify(execFile)
const WINDOWS_LOOPBACK_HOST = '127.0.0.1'
const REQUEST_TIMEOUT_MS = 20_000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_VOICE_BYTES = 20 * 1024 * 1024
/**
 * 单条微信消息的软上限。hook 侧上限是 2000 字，这里留 200 字余量，
 * 避免中文按 UTF-16 计数时踩线被拒。
 */
const TEXT_SEGMENT_LIMIT = 1_800
/** 瞬时失败最多尝试 3 次（含首次）。 */
const SEND_MAX_ATTEMPTS = 3
const SEND_RETRY_DELAYS_MS = [400, 1_200]
// 语音编码由 native runtime 内的 SILK 实现完成，不再是外部编码器进程。
const VOICE_ENCODER_NAME = 'silk'
const VOICE_ENCODER_VERSION = 'tm-wechat-native'
let latestVoiceDiagnostic: PersonalWechatVoiceDiagnostic | null = null
const WECHAT_FILES_ROOT = join(
  homedir(),
  'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files'
)

const ASCII_PATH_PATTERN = /^[\x20-\x7e]+$/

function isAsciiPath(value: string): boolean {
  return ASCII_PATH_PATTERN.test(value)
}

export function normalizeWindowsWechatPort(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (!/^\d{1,5}$/.test(text)) return null
  const port = Number(text)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  return String(port)
}

function windowsHookHost(port?: unknown): string | null {
  const configuredPort =
    port === undefined
      ? normalizeWindowsWechatPort(loadSettings().windowsWechatPort)
      : normalizeWindowsWechatPort(port)
  return configuredPort ? `${WINDOWS_LOOPBACK_HOST}:${configuredPort}` : null
}

export function buildPersonalWechatRuntimePath(): string {
  const existing = String(process.env['PATH'] || '')
  const bundledFfmpeg = resolveBundledFfmpegPath()
  if (!bundledFfmpeg || !existsSync(bundledFfmpeg)) return existing
  return [dirname(bundledFfmpeg), existing].filter(Boolean).join(delimiter)
}

/**
 * Build the environment used by TraceMemo's local voice encoding helpers.
 * Keep this in one place so environment checks cannot accidentally inspect a
 * different ffmpeg than the sender process.
 */
export function buildPersonalWechatRuntimeEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: buildPersonalWechatRuntimePath()
  }
}

const VOICE_DIAGNOSTIC_KEYS = new Set([
  'input_bytes',
  'normalized_input_bytes',
  'pcm_size',
  'sample_rate',
  'channels',
  'input_duration_ms',
  'upload_result',
  'upload_data_len',
  'silk_duration_ms',
  'send_result',
  'voice_send_mode',
  'failure_phase',
  'error'
])

function redactVoiceDiagnosticDetails(details: Record<string, unknown>): Record<string, unknown> {
  const allowedDetails = Object.fromEntries(
    Object.entries(details).filter(([key]) => VOICE_DIAGNOSTIC_KEYS.has(key))
  )
  if (allowedDetails.error !== undefined) {
    const rawError = String(allowedDetails.error).trim()
    allowedDetails.error = rawError
      .replace(
        /(["']?(?:aesKey|cdnKey|token|cookie|authorization|access_token|secret|apiKey)["']?\s*[:=]\s*["']?)([^"',;\]}\s]+)(["']?)/gi,
        '$1[redacted]$3'
      )
      .replace(/Bearer\s+[^\s,;\]}"']+/gi, 'Bearer [redacted]')
      .slice(0, 1_000)
  }
  return allowedDetails
}

export function buildPersonalWechatVoiceDiagnostic(
  requestId: string,
  phase: PersonalWechatVoiceDiagnostic['phase'],
  details: Record<string, unknown>,
  previous: PersonalWechatVoiceDiagnostic | null = null
): PersonalWechatVoiceDiagnostic {
  const allowedDetails = redactVoiceDiagnosticDetails(details)
  return {
    ...(previous?.request_id === requestId ? previous : {}),
    request_id: requestId,
    voice_id: requestId,
    phase,
    encoder_name: VOICE_ENCODER_NAME,
    encoder_version: VOICE_ENCODER_VERSION,
    ...allowedDetails
  }
}

function logVoiceAttempt(
  requestId: string,
  phase: PersonalWechatVoiceDiagnostic['phase'],
  details: Record<string, unknown> = {}
): void {
  latestVoiceDiagnostic = buildPersonalWechatVoiceDiagnostic(
    requestId,
    phase,
    details,
    latestVoiceDiagnostic
  )
  const allowedDetails = redactVoiceDiagnosticDetails(details)
  appLogger.write({
    level: phase === 'failed' ? 'error' : 'info',
    scope: 'personal-wechat-voice',
    message: `voice_${phase}`,
    details: {
      request_id: requestId,
      voice_id: requestId,
      encoder_name: VOICE_ENCODER_NAME,
      encoder_version: VOICE_ENCODER_VERSION,
      ...allowedDetails
    }
  })
}

async function detectVoiceDurationMs(filePath: string): Promise<number | undefined> {
  const data = readFileSync(filePath)
  if (data.subarray(0, 10).equals(Buffer.from('\x02#!SILK_V3'))) {
    const decoded = await new SilkAudioDecoder().decode({
      data,
      codec: 'silk',
      sourceHash: createHash('sha256').update(data).digest('hex')
    })
    const samples = decoded.channels > 0 ? decoded.pcm.length / 2 / decoded.channels : 0
    if (samples > 0 && decoded.sampleRate > 0) {
      return Math.round((samples / decoded.sampleRate) * 1000)
    }
  }

  const ffmpegPath = resolveBundledFfmpegPath()
  if (!ffmpegPath || !existsSync(ffmpegPath)) return undefined
  let output = ''
  try {
    const result = await execFileAsync(ffmpegPath, ['-i', filePath, '-f', 'null', '-'], {
      maxBuffer: 2 * 1024 * 1024
    })
    output = `${result.stdout || ''}\n${result.stderr || ''}`
  } catch (error) {
    output = `${(error as { stdout?: string }).stdout || ''}\n${(error as { stderr?: string }).stderr || ''}`
  }
  const match = output.match(/Duration:\s*(\d+):(\d{2}):(\d+(?:\.\d+)?)/i)
  if (match) {
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
  }
  return undefined
}

async function prepareWindowsVoiceFile(filePath: string): Promise<{
  filePath: string
  durationMs?: number
  temporary: boolean
}> {
  const source = readFileSync(filePath)
  if (source.subarray(0, 10).equals(Buffer.from('\x02#!SILK_V3'))) {
    return { filePath, durationMs: await detectVoiceDurationMs(filePath), temporary: false }
  }

  const ffmpegPath = resolveBundledFfmpegPath()
  if (!ffmpegPath || !existsSync(ffmpegPath)) {
    throw new Error('Windows 语音发送需要可用的 FFmpeg 才能转换为 SILK')
  }
  const result = await execFileAsync(
    ffmpegPath,
    ['-v', 'error', '-i', filePath, '-ar', '24000', '-ac', '1', '-f', 's16le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: MAX_VOICE_BYTES }
  )
  const pcm = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || '')
  if (!pcm.length) throw new Error('语音转换失败：没有得到 PCM 音频数据')
  const encoded = await new SilkAudioEncoder().encode(pcm, 24_000)
  if (!encoded.data.length) throw new Error('语音转换失败：没有得到 SILK 数据')
  const convertedPath = join(tmpdir(), `tracememo-voice-${randomBytes(8).toString('hex')}.silk`)
  writeFileSync(convertedPath, encoded.data)
  return {
    filePath: convertedPath,
    ...(encoded.durationMs > 0 ? { durationMs: encoded.durationMs } : {}),
    temporary: true
  }
}

function windowsImageTempRoot(): string {
  const candidates = [
    process.platform === 'win32' && process.env['PUBLIC']
      ? join(process.env['PUBLIC'], 'TraceMemo', 'temp')
      : undefined,
    process.platform === 'win32' && process.env['ProgramData']
      ? join(process.env['ProgramData'], 'TraceMemo', 'temp')
      : undefined,
    process.platform === 'win32' ? join('C:', 'Users', 'Public', 'TraceMemo', 'temp') : undefined,
    tmpdir(),
    process.env['TEMP'],
    process.env['TMP']
  ]
  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim()
    if (!normalized || !isAsciiPath(normalized)) continue
    try {
      mkdirSync(normalized, { recursive: true })
      return normalized
    } catch {
      //
    }
  }
  throw new Error('无法创建 Windows 图片临时目录')
}

export function prepareWindowsImageFile(
  filePath: string,
  forceCopy = false
): {
  filePath: string
  temporary: boolean
} {
  const normalized = String(filePath || '').trim()
  if (!forceCopy && isAsciiPath(normalized)) return { filePath: normalized, temporary: false }

  const extension = extname(normalized).toLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.png'
  const temporaryRoot = windowsImageTempRoot()
  if (forceCopy) {
    // Recover stale copies left by an application exit before the cleanup timer.
    for (const name of readdirSync(temporaryRoot)) {
      if (!/^tm-img-[a-f0-9]{16}\.[a-z0-9]{1,8}$/.test(name)) continue
      const stale = join(temporaryRoot, name)
      try {
        if (Date.now() - statSync(stale).mtimeMs > 10 * 60_000) unlinkSync(stale)
      } catch {
        // A busy file can be retried during the next send.
      }
    }
  }
  const temporaryPath = join(
    temporaryRoot,
    `tm-img-${randomBytes(8).toString('hex')}${safeExtension}`
  )
  if (!isAsciiPath(temporaryPath)) throw new Error('Windows 图片临时路径必须只包含 ASCII 字符')
  try {
    copyFileSync(normalized, temporaryPath)
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // A partially copied file is best-effort cleanup only.
    }
    throw error
  }
  return { filePath: temporaryPath, temporary: true }
}

function prepareMacWechatImageFile(
  filePath: string,
  senderWxid: string,
  wechatFilesRoot = WECHAT_FILES_ROOT
): { filePath: string; md5: string } {
  /* Stage the image in WeChat's temporary image directory using the
   * filename/hash layout required by the macOS native send path:
   * - stage inside the active account's ImageTemp tree selected by
   *   findWechatImagePath(), not an arbitrary readable sandbox directory;
   * - append a per-send salt before calculating MD5, so the staged image and
   *   the MD5 passed to the CDN task describe the same unique byte stream. */
  const temporaryRoot = findWechatImagePath(wechatFilesRoot, new Date(), senderWxid)
  if (!temporaryRoot) throw new Error('无法定位当前微信账号的图片临时目录')
  mkdirSync(temporaryRoot, { recursive: true })
  const extension = extname(filePath).toLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension.slice(1) : 'png'
  const source = readFileSync(filePath)
  const salt = Buffer.from(
    `\n#md5_salt_${process.hrtime.bigint()}_${Math.floor(Math.random() * 10_000)}#`,
    'utf8'
  )
  const staged = Buffer.concat([source, salt])
  const temporaryPath = join(
    temporaryRoot,
    `${randomBytes(8).toString('hex')}_${Math.floor(Date.now() / 1000)}.${safeExtension}`
  )
  writeFileSync(temporaryPath, staged, { mode: 0o644 })
  return {
    filePath: temporaryPath,
    md5: createHash('md5').update(staged).digest('hex')
  }
}

function stageMacWechatImageForMessageSourceSend(
  filePath: string,
  senderWxid: string,
  wechatFilesRoot = WECHAT_FILES_ROOT
): string {
  const temporaryRoot = findWechatImagePath(wechatFilesRoot, new Date(), senderWxid)
  if (!temporaryRoot) throw new Error('无法定位当前微信账号的图片临时目录')
  mkdirSync(temporaryRoot, { recursive: true })
  const extension = extname(filePath).toLowerCase()
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : '.png'
  const stagedPath = join(
    temporaryRoot,
    `tm-${randomBytes(8).toString('hex')}-${Math.floor(Date.now() / 1000)}${safeExtension}`
  )
  copyFileSync(filePath, stagedPath)
  return stagedPath
}

/** Locate the current account's temporary image directory consumed by the image send path. */
export function findWechatImagePath(
  root = WECHAT_FILES_ROOT,
  now = new Date(),
  senderWxid?: string
): string | undefined {
  try {
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const candidates: Array<{ path: string; mtime: number }> = []
    const fallbacks: Array<{ path: string; mtime: number }> = []
    for (const account of readdirSync(root)) {
      if (senderWxid && !accountDirectoryBelongsToIdentity(account, senderWxid)) continue
      const tempRoot = join(root, account, 'temp')
      if (!existsSync(tempRoot)) continue
      fallbacks.push({
        path: join(tempRoot, 'ImageTemp', month),
        mtime: statSync(tempRoot).mtimeMs
      })
      const imageTempPath = join(tempRoot, 'ImageTemp', month)
      if (existsSync(imageTempPath)) {
        candidates.push({ path: imageTempPath, mtime: statSync(imageTempPath).mtimeMs })
      }
      for (const tempId of readdirSync(tempRoot)) {
        const imagePath = join(tempRoot, tempId, month, 'Img')
        if (existsSync(imagePath)) {
          candidates.push({ path: imagePath, mtime: statSync(imagePath).mtimeMs })
        }
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    fallbacks.sort((a, b) => b.mtime - a.mtime)
    const selected = candidates[0]?.path || fallbacks[0]?.path
    return selected ? `${selected}${sep}` : undefined
  } catch {
    return undefined
  }
}

async function requestWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 2_000
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

type WindowsHookResponse = Record<string, unknown>

export class WindowsHookHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string
  ) {
    const detail = responseBody.trim()
    super(detail ? `HTTP ${status}: ${detail.slice(0, 1_000)}` : `HTTP ${status}`)
    this.name = 'WindowsHookHttpError'
  }
}

export function parseWindowsHookResponse(
  responseText: string,
  requireSuccessRet = false
): WindowsHookResponse {
  const normalized = responseText.trim()
  if (!normalized) throw new Error('Windows 微信发送能力返回空响应')

  let parsed: unknown
  try {
    parsed = JSON.parse(normalized)
  } catch {
    throw new Error(`Windows 微信发送能力返回无效 JSON：${normalized.slice(0, 200)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Windows 微信发送能力返回格式无效')
  }

  const response = parsed as WindowsHookResponse
  if (requireSuccessRet && response.ret !== 0) {
    const detail = response.retmsg ?? response.msg
    throw new Error(
      detail ? String(detail) : `Windows 微信发送能力返回失败：ret=${String(response.ret)}`
    )
  }
  return response
}

export function parseWindowsLoginStatus(response: WindowsHookResponse): boolean {
  return response.status === true
}

export function buildWindowsWechatRequest(
  request: PersonalWechatSendRequest,
  options: { filePath?: string; durationMs?: number } = {}
): {
  endpoint: string
  body: Record<string, unknown>
} {
  const target = String(request.to || '').trim()
  if (request.type === 'text') {
    return {
      endpoint: '/SendMsg',
      body: { toWxid: target, type: 'text', msg: request.text.trim() }
    }
  }
  if (request.type === 'image') {
    return {
      endpoint: '/SendMsg',
      body: { toWxid: target, type: 'image', msg: String(request.filePath || '').trim() }
    }
  }

  const fromId = String(request.fromId || '').trim()
  const filePath = String(options.filePath || request.filePath || '').trim()
  const durationMs = options.durationMs ?? request.durationMs
  return {
    endpoint: '/SendMsg',
    body: {
      toWxid: target,
      type: 'voice',
      msg: filePath,
      ...(fromId ? { fromWxid: fromId } : {}),
      ...(durationMs !== undefined ? { duration: durationMs } : {})
    }
  }
}

function windowsStatusBase(host = windowsHookHost() || ''): PersonalWechatSenderStatus {
  return {
    state: 'checking',
    platform: process.platform,
    arch: process.arch,
    sipDisabled: true,
    wechatRunning: false,
    runtimeReady: false,
    endpoint: host,
    endpointReady: false,
    attachReady: false,
    baseAddressReady: false,
    textHookInstalled: false,
    textHookReady: false,
    imageHookInstalled: false,
    imageHookReady: false,
    messageListenerReady: false,
    canSend: false,
    canSendText: false,
    canSendImage: false,
    canSendVoice: false,
    message: '正在检查 Windows 微信消息接口'
  }
}

/** 文件字节数；读不到时返回 `-1`（**不是** 0 —— 0 会被误读成「空文件」）。 */
function safeFileSize(target: string): number {
  try {
    return statSync(target).size
  } catch {
    return -1
  }
}

function isDefinitiveImageSourcePreparationFailure(message: string): boolean {
  return message.trim() === 'IMAGE_PREPARATION_FAILED:0'
}

/**
 * 发送链路诊断日志（排查「hook 报成功、群里却没有消息」时用）。
 *
 * 只有在设置里打开「调试模式」时才输出，所以正常使用不会刷屏。
 *
 * **隐私约束**：只允许输出类型、字节数、HTTP 状态码、hook 的 `ret` 这类结构性字段。
 * 文件名、完整路径、wxid、群名、消息正文不进日志。
 */
function logSendDiagnostic(
  stage: string,
  detail: Record<string, string | number | boolean | null>
): void {
  try {
    if (!loadSettings().debugEnabled) return
  } catch {
    return
  }
  console.log(`[SendDiag] ${stage} ${JSON.stringify(detail)}`)
}

/**
 * 发送完成后**保留**图片临时文件的时长（毫秒）。默认 `0` = 立刻删除（现行行为）。
 *
 * 为什么留这个开关：`finally` 里的删除发生在 **hook 返回之后**，这隐含假设
 * 「hook 返回时发送已经完成」。如果 hook 其实是「先回 200、后台再读文件」，
 * 文件就可能在它读到之前已经被删掉 —— 现象正好是「hook 报成功、微信里没有消息」。
 *
 * 置为非 0 时可分辨两类失败：保留期间图片到了 ⇒ 删除时机问题（修法与 hook 约定文件生命周期）；
 * 仍然没到 ⇒ 与文件生命周期无关。
 */
const WINDOWS_TEMP_IMAGE_GRACE_MS = 0

async function requestWindowsHook(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
  method: 'GET' | 'POST' = 'POST',
  host = windowsHookHost()
): Promise<WindowsHookResponse> {
  if (!host) throw new Error('尚未配置微信发送能力端口')
  const startedAt = Date.now()
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' }
  }
  if (method !== 'GET') init.body = JSON.stringify(body)
  logSendDiagnostic('hook-request', {
    endpoint,
    method,
    // 只报 payload 里有没有内容，不报内容本身。
    hasPayload: method !== 'GET' ? init.body !== undefined : false
  })
  const response = await requestWithTimeout(`http://${host}${endpoint}`, init, timeoutMs)
  const responseText = await response.text()
  if (!response.ok) {
    // HTTP 层失败：状态码不是隐私，正文可能是（hook 有时会把请求原样回显）。
    logSendDiagnostic('hook-response', {
      endpoint,
      httpStatus: response.status,
      ok: false,
      bodyLength: responseText.length,
      elapsedMs: Date.now() - startedAt
    })
    throw new WindowsHookHttpError(response.status, responseText)
  }
  const parsed = parseWindowsHookResponse(responseText, method === 'POST')
  logSendDiagnostic('hook-response', {
    endpoint,
    httpStatus: response.status,
    ok: true,
    ret: typeof parsed.ret === 'number' ? parsed.ret : null,
    retMessageLength: String(parsed.retmsg ?? parsed.msg ?? '').length,
    elapsedMs: Date.now() - startedAt
  })
  return parsed
}

/**
 * 解析 `netstat -ano` 输出里的本机监听端口。
 *
 * 只用 Windows 自带的 netstat，不引入原生依赖；
 * 兼容 `127.0.0.1:9999`、`0.0.0.0:8000`、`[::]:135` 三种写法。
 */
export function parseListeningPorts(netstatOutput: string): string[] {
  const ports = new Set<string>()
  for (const line of String(netstatOutput || '').split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(.+):(\d{1,5})\s+\S+\s+LISTENING/i)
    if (!match) continue
    const address = match[1].trim()
    const port = Number(match[2])
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue
    // 只保留本机可达的监听地址（回环 / 全部网卡 / IPv6 任意）。
    const isLoopback =
      address === '127.0.0.1' ||
      address === '0.0.0.0' ||
      address === '[::]' ||
      address === '[::1]' ||
      address === '::'
    if (!isLoopback) continue
    ports.add(String(port))
  }
  return [...ports]
}

/** 常见 hook/中转服务端口优先探测，减少「刚好排在后半段」的等待。 */
const PREFERRED_ENDPOINT_PORTS = [
  '9999',
  '19088',
  '10086',
  '30001',
  '10010',
  '8888',
  '8000',
  '8080',
  '3000',
  '3001',
  '5000',
  '9000'
]
const ENDPOINT_SCAN_LIMIT = 80
const ENDPOINT_PROBE_TIMEOUT_MS = 700

/**
 * 扫描本机监听端口，找出符合 `/getLoginInfo` 契约的微信发送接口。
 *
 * 说明：TraceMemo 本身不带注入式 hook；这个扫描只负责「你机器上已经跑了一个
 * 发送接口时，把它的端口找出来」，不会去创建或修改任何服务。
 * 只发 GET，不发消息、不写配置。
 */
export async function scanWindowsWechatEndpoint(): Promise<PersonalWechatEndpointScanResult> {
  if (process.platform !== 'win32') {
    return {
      success: false,
      scanned: 0,
      candidates: [],
      error: '只有 Windows 需要配置发送接口端口'
    }
  }
  let output = ''
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], {
      windowsHide: true,
      timeout: 8_000,
      maxBuffer: 8 * 1024 * 1024
    })
    output = String(stdout || '')
  } catch (error) {
    return {
      success: false,
      scanned: 0,
      candidates: [],
      error: `读取本机端口失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  const listening = parseListeningPorts(output)
  const ordered = [
    ...PREFERRED_ENDPOINT_PORTS.filter((port) => listening.includes(port)),
    ...listening.filter((port) => !PREFERRED_ENDPOINT_PORTS.includes(port))
  ].slice(0, ENDPOINT_SCAN_LIMIT)

  const probes = await Promise.all(ordered.map((port) => probeEndpoint(port)))
  const candidates = probes
    .filter((item): item is PersonalWechatEndpointCandidate => Boolean(item))
    .sort((left, right) => Number(right.matched) - Number(left.matched))
  const best = candidates.find((item) => item.matched)
  return {
    success: true,
    scanned: ordered.length,
    candidates: candidates.slice(0, 20),
    ...(best ? { bestPort: best.port } : {})
  }
}

async function probeEndpoint(port: string): Promise<PersonalWechatEndpointCandidate | null> {
  const probe = await probeHook(`127.0.0.1:${port}`, ENDPOINT_PROBE_TIMEOUT_MS)
  if (!probe) return null
  return {
    port,
    // 接口契约匹配就算数；登录态单独放在 loggedIn，
    // 否则「hook 在跑但微信未登录」会被误判成没找到接口。
    matched: true,
    loggedIn: probe.loggedIn,
    status: 200,
    detail: probe.detail,
    protocol: probe.protocol,
    protocolLabel: HOOK_PROTOCOL_LABELS[probe.protocol]
  }
}

/**
 * 把长文本切成多条消息。
 * 优先级：段落 → 句末标点 → 空格 → 硬切。切点尽量落在句子边界，
 * 避免把一句话从中间劈开导致对方读到半句。
 */
export function splitWechatText(text: string, limit = TEXT_SEGMENT_LIMIT): string[] {
  const normalized = String(text || '').trim()
  if (!normalized) return []
  if (normalized.length <= limit) return [normalized]

  const chunks: string[] = []
  let rest = normalized
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const candidates = [
      window.lastIndexOf('\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('；'),
      window.lastIndexOf('. '),
      window.lastIndexOf(' ')
    ]
    const cut = Math.max(...candidates)
    // 找不到像样的切点就硬切，但要避免切出空白段。
    const at = cut > limit * 0.4 ? cut + 1 : limit
    const chunk = rest.slice(0, at).trim()
    if (chunk) chunks.push(chunk)
    rest = rest.slice(at).trim()
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** 发送失败分类；界面按 code 给不同建议，不再只显示一坨原始报错。 */
export function classifyWechatSendError(error: unknown): {
  code: PersonalWechatSendErrorCode
  message: string
} {
  const raw = error instanceof Error ? error.message : String(error || '')
  if (error instanceof WindowsHookHttpError) {
    if (error.status === 429) {
      return { code: 'rate_limited', message: `发送过于频繁（HTTP 429）：${raw}` }
    }
    if (error.status >= 500) {
      return { code: 'hook_error', message: `发送服务内部错误（HTTP ${error.status}）：${raw}` }
    }
    return { code: 'hook_error', message: raw }
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return {
      code: 'timeout',
      message: '发送请求超时。消息可能已经发出，请先在微信里确认再决定是否重发。'
    }
  }
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|EPIPE|socket hang up|fetch failed/i.test(raw)) {
    return { code: 'network', message: `连接不上微信发送服务：${raw}` }
  }
  if (/空响应|无效 JSON|返回格式无效/i.test(raw)) {
    return { code: 'hook_error', message: raw }
  }
  return { code: 'hook_error', message: raw || '发送失败' }
}

/** 只有「确定没送达」的失败才重试；超时不重试，避免同一条发两遍。 */
function isTransientSendError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false
  if (error instanceof WindowsHookHttpError) return error.status >= 500 || error.status === 429
  const raw = error instanceof Error ? error.message : String(error || '')
  return /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|fetch failed|空响应/i.test(raw)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 带重试的 hook 调用，返回实际尝试次数，便于界面说明「重试过才成功」。 */
async function requestWindowsHookWithRetry(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
  host = windowsHookHost()
): Promise<{ response: WindowsHookResponse; attempts: number }> {
  let attempts = 0
  for (let index = 0; index < SEND_MAX_ATTEMPTS; index += 1) {
    attempts += 1
    try {
      const response = await requestWindowsHook(endpoint, body, timeoutMs, 'POST', host)
      return { response, attempts }
    } catch (error) {
      const canRetry = index < SEND_MAX_ATTEMPTS - 1 && isTransientSendError(error)
      if (!canRetry) throw error
      const wait = SEND_RETRY_DELAYS_MS[Math.min(index, SEND_RETRY_DELAYS_MS.length - 1)]
      logSendDiagnostic('hook-retry', { endpoint, attempt: attempts, waitMs: wait })
      await delay(wait)
    }
  }
  throw new Error('发送重试已用完')
}

export class PersonalWechatSendService {
  /** Windows 按账号排队，其他平台保持同一接收者串行。 */
  private readonly sendQueues = new Map<string, Promise<unknown>>()
  private lastWechat4Submission = 0

  constructor(private readonly wechatFilesRoot = WECHAT_FILES_ROOT) {}

  async getStatus(): Promise<PersonalWechatSenderStatus> {
    // macOS 发送能力完全由 native runtime（tm-wechat-host）提供，
    // 这里保持同源，避免出现第二套状态判断。
    if (process.platform === 'darwin') return macWechatRuntimeManager.buildSenderStatus()
    return this.getWindowsStatus()
  }

  async checkWindowsStatus(port?: string): Promise<PersonalWechatSenderStatus> {
    if (process.platform !== 'win32') return this.getStatus()
    const normalizedPort = normalizeWindowsWechatPort(port)
    if (!normalizedPort) {
      const base = windowsStatusBase()
      return {
        ...base,
        state: 'error',
        message: '请输入 1 到 65535 之间的微信发送能力端口',
        error: '端口格式无效或为空'
      }
    }
    return this.getWindowsStatus(normalizedPort)
  }

  getLatestVoiceDiagnostic(): PersonalWechatVoiceDiagnostic | null {
    return latestVoiceDiagnostic ? { ...latestVoiceDiagnostic } : null
  }

  async send(request: PersonalWechatSendRequest): Promise<PersonalWechatSendResult> {
    // Windows 的不同接收者也共用一个内部发送通道。
    const key =
      process.platform === 'win32'
        ? 'win32:account'
        : `${process.platform}:${String(request?.to || '').trim()}`
    return this.enqueueSend(key, () => this.sendNow(request))
  }

  private enqueueSend<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sendQueues.get(key) || Promise.resolve()
    const run = previous.then(task, task)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.sendQueues.set(key, settled)
    void settled.then(() => {
      if (this.sendQueues.get(key) === settled) this.sendQueues.delete(key)
    })
    return run
  }

  private async sendNow(request: PersonalWechatSendRequest): Promise<PersonalWechatSendResult> {
    if (process.platform === 'win32') return this.sendWindows(request)
    if (process.platform === 'darwin') {
      if (request.type === 'text') return this.sendMacText(request)
      if (request.type === 'image') return this.sendMacImage(request)
      if (request.type === 'voice') return this.sendMacVoice(request)
    }
    return {
      success: false,
      status: await this.getStatus(),
      error: '当前系统暂不支持个人微信发送'
    }
  }

  async rebind(): Promise<PersonalWechatSenderStatus> {
    return this.getWindowsStatus()
  }

  /**
   * hook 调用重试：只重试「确定没送达」的失败（5xx / 连不上 / 空响应）。
   * 超时不重试，避免同一条消息发两遍。
   */
  private async callHookWithRetry(task: () => Promise<void>): Promise<number> {
    let attempts = 0
    for (let index = 0; index < SEND_MAX_ATTEMPTS; index += 1) {
      attempts += 1
      try {
        await task()
        return attempts
      } catch (error) {
        const transient =
          error instanceof HookCallError
            ? (error.status ?? 0) >= 500 || (error.status ?? 0) === 429
            : isTransientSendError(error)
        if (index >= SEND_MAX_ATTEMPTS - 1 || !transient) throw error
        const wait = SEND_RETRY_DELAYS_MS[Math.min(index, SEND_RETRY_DELAYS_MS.length - 1)]
        logSendDiagnostic('hook-retry', { attempt: attempts, waitMs: wait })
        await delay(wait)
      }
    }
    throw new Error('发送重试已用完')
  }

  private async submitHook(
    protocol: WechatHookProtocol,
    task: () => Promise<void>
  ): Promise<number> {
    if (protocol !== 'wechat4-hook') return this.callHookWithRetry(task)
    const wait = 2_000 - (Date.now() - this.lastWechat4Submission)
    if (wait > 0) await delay(wait)
    try {
      // The server may accept a message before the HTTP response is lost.
      await task()
      return 1
    } finally {
      this.lastWechat4Submission = Date.now()
    }
  }

  private async getWindowsStatus(port?: string): Promise<PersonalWechatSenderStatus> {
    const host = windowsHookHost(port)
    const base = windowsStatusBase(host || '')
    if (!host) {
      return {
        ...base,
        state: 'error',
        message: '尚未配置微信发送能力端口',
        error: '请先输入端口并检测后保存'
      }
    }
    // 逐个协议探测：trace-hook / wxhelper / wcf-http，命中即用。
    const probe = await probeHook(host, 1_500)
    if (!probe) {
      return {
        ...base,
        state: 'wechat_not_running',
        message: '端口有服务，但不符合任何已知发送接口',
        error:
          '未探测到 /getLoginInfo、/api/checkLogin、/login 或 /QueryDB/status。请确认发送组件已启动、端口正确。'
      }
    }
    const connected = {
      wechatRunning: true,
      runtimeReady: true,
      endpointReady: true,
      attachReady: true,
      baseAddressReady: true,
      textHookInstalled: true,
      textHookReady: true,
      imageHookInstalled: true,
      imageHookReady: true,
      messageListenerReady: false,
      hookProtocol: probe.protocol,
      hookProtocolLabel: HOOK_PROTOCOL_LABELS[probe.protocol],
      ...(probe.loginState ? { loginState: probe.loginState } : {})
    }
    if (!probe.loggedIn) {
      return {
        ...base,
        ...connected,
        state: 'hook_not_ready',
        message: `已连接 ${HOOK_PROTOCOL_LABELS[probe.protocol]}，${
          probe.loginState === 'logged_out'
            ? '微信尚未登录'
            : probe.loginState === 'unknown'
              ? '登录状态读取失败'
              : '组件尚未确认登录'
        }`,
        error:
          probe.loginState === 'logged_out'
            ? '组件已确认当前账号未登录，请登录微信后重试。'
            : probe.loginState === 'unknown'
              ? `组件无法确认当前登录状态：${probe.loginError || '账号对象暂不可用'}。请稍后重试；持续失败时检查微信版本和组件是否匹配。`
              : probe.protocol === 'wechat4-hook'
                ? '端口连接正常，但旧组件返回 IsLogin=0。请退出微信后使用新版配套组件启动，再检测登录状态。'
                : '请登录微信后再检测；若已登录，请检查发送组件的登录状态检测。'
      }
    }
    if (probe.protocol === 'wechat4-hook') {
      return {
        ...base,
        ...connected,
        state: 'hook_not_ready',
        message: '微信已登录 · 发送已暂停',
        error: WECHAT4_SEND_SUSPENDED_REASON
      }
    }
    const supportsVoice = hookSupportsVoice(probe.protocol)
    return {
      ...base,
      ...connected,
      state: 'online' as const,
      canSend: true,
      canSendText: true,
      canSendImage: true,
      canSendVoice: supportsVoice,
      message: `已就绪 · ${HOOK_PROTOCOL_LABELS[probe.protocol]}${supportsVoice ? '' : '（该接口不支持语音）'}`
    }
  }

  /*
   * macOS native runtime 的文字发送：HTTP POST /sendText 到 tm-wechat-host。
   * 绑定状态由 host 侧保证；未绑定/未就绪时返回与旧契约一致的结果结构。
   */
  private async sendMacText(
    request: Extract<PersonalWechatSendRequest, { type: 'text' }>
  ): Promise<PersonalWechatSendResult> {
    await macWechatRuntimeManager.ensureStarted()
    const initialStatus = await macWechatRuntimeManager.buildSenderStatus()
    if (!initialStatus.canSendText) {
      return {
        success: false,
        status: initialStatus,
        error: initialStatus.message || '微信发送能力未就绪'
      }
    }
    const sendMechanism = await macWechatRuntimeManager.getSendMechanism()
    if (request.at && sendMechanism !== 'tm-message-source-send') {
      return {
        success: false,
        status: initialStatus,
        error: '当前微信发送组件不支持原生群聊 @，请升级微信与发送组件'
      }
    }
    if (sendMechanism === 'tm-message-source-send') {
      const result = await this.postMacHost(
        '/sendMsg',
        {
          type: 'text',
          to: request.to,
          text: request.text,
          is_group: Boolean(request.isGroup),
          ...(request.at ? { at: request.at } : {})
        },
        50_000
      )
      const status = await macWechatRuntimeManager.buildSenderStatus()
      if (!result?.ok) {
        return { success: false, status, error: result?.message || '文字发送失败' }
      }
      return { success: true, status }
    }

    const payload = JSON.stringify({
      to: request.to,
      text: request.text,
      isGroup: Boolean(request.isGroup)
    })
    const response = await fetch(`http://127.0.0.1:${macWechatRuntimeManager.getPort()}/sendText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(40_000)
    }).catch(() => null)

    if (response === null || !response.ok) {
      const status = await macWechatRuntimeManager.buildSenderStatus()
      return {
        success: false,
        status,
        error: `发送请求失败（HTTP ${response?.status ?? '无响应'}）`
      }
    }

    const result = (await response.json()) as { code: number; ok: boolean; message: string }
    const resultStatus = await macWechatRuntimeManager.buildSenderStatus()
    if (!result.ok) {
      return { success: false, status: resultStatus, error: result.message || '发送失败' }
    }
    return { success: true, status: resultStatus }
  }

  /*
   * Resolve the bound account's own wxid from the local WeChat data root.
   * The media proto embeds the sender, and the mac runtime does not learn it
   * from inbound traffic, so it is read from
   * the on-disk account identity instead.
   */
  private async resolveMacSenderWxid(): Promise<string> {
    const identity = readLocalAccountIdentity(this.wechatFilesRoot)
    return identity?.wxid ?? ''
  }

  private async postMacHost(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number
  ): Promise<{ code: number; ok: boolean; message: string } | null> {
    const response = await fetch(`http://127.0.0.1:${macWechatRuntimeManager.getPort()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    }).catch(() => null)
    if (response === null || !response.ok) return null
    return (await response.json().catch(() => null)) as {
      code: number
      ok: boolean
      message: string
    } | null
  }

  private async sendMacImage(
    request: Extract<PersonalWechatSendRequest, { type: 'image' }>
  ): Promise<PersonalWechatSendResult> {
    await macWechatRuntimeManager.ensureStarted()
    const initialStatus = await macWechatRuntimeManager.buildSenderStatus()
    const fail = async (error: string): Promise<PersonalWechatSendResult> => {
      const status = await macWechatRuntimeManager.buildSenderStatus()
      return { success: false, status, error }
    }
    if (!initialStatus.canSendImage) {
      return fail('微信发送能力未就绪')
    }
    const filePath = String(request.filePath || '').trim()
    if (!filePath || !existsSync(filePath)) return fail('请选择有效的图片文件')
    const sendMechanism = await macWechatRuntimeManager.getSendMechanism()
    const sender = await this.resolveMacSenderWxid()
    if (!sender) return fail('无法识别当前微信账号 wxid')
    if (sendMechanism === 'tm-message-source-send') {
      let stagedPath = ''
      let sourceError = ''
      try {
        stagedPath = stageMacWechatImageForMessageSourceSend(filePath, sender, this.wechatFilesRoot)
        const sent = await this.postMacHost(
          '/sendMsg',
          { type: 'image', to: request.to, path: stagedPath },
          55_000
        )
        const status = await macWechatRuntimeManager.buildSenderStatus()
        if (!sent?.ok) {
          sourceError = sent?.message || '图片发送失败'
        } else {
          return { success: true, status }
        }
      } catch (error) {
        sourceError = error instanceof Error ? error.message : String(error)
      } finally {
        if (stagedPath) {
          try {
            unlinkSync(stagedPath)
          } catch {
            // Best-effort cleanup after WeChat has consumed the staged image.
          }
        }
      }
      if (!isDefinitiveImageSourcePreparationFailure(sourceError)) return fail(sourceError)
    }

    let uploadPath = ''
    try {
      const prepared = prepareMacWechatImageFile(filePath, sender, this.wechatFilesRoot)
      uploadPath = prepared.filePath
      const upload = await this.postMacHost(
        '/uploadImage',
        { to: request.to, md5: prepared.md5, filePath: uploadPath },
        20_000
      )
      if (!upload || !upload.ok) {
        return fail(upload?.message || '图片上传失败')
      }
      const sent = await this.postMacHost('/sendImage', { sender, to: request.to }, 50_000)
      if (!sent || !sent.ok) {
        return fail(sent?.message || '图片发送失败')
      }
      const status = await macWechatRuntimeManager.buildSenderStatus()
      return { success: true, status }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    } finally {
      if (uploadPath) {
        try {
          unlinkSync(uploadPath)
        } catch {
          // Upload staging cleanup is best effort.
        }
      }
    }
  }

  private async sendMacVoice(
    request: Extract<PersonalWechatSendRequest, { type: 'voice' }>
  ): Promise<PersonalWechatSendResult> {
    const requestId = randomUUID()
    await macWechatRuntimeManager.ensureStarted()
    const initialStatus = await macWechatRuntimeManager.buildSenderStatus()
    const fail = async (
      error: string,
      failurePhase = 'preflight'
    ): Promise<PersonalWechatSendResult> => {
      logVoiceAttempt(requestId, 'failed', { failure_phase: failurePhase, error })
      const status = await macWechatRuntimeManager.buildSenderStatus()
      return { success: false, status, error }
    }
    if (!initialStatus.canSendVoice) {
      return fail('微信发送能力未就绪')
    }
    const filePath = String(request.filePath || '').trim()
    if (!filePath || !existsSync(filePath)) return fail('请选择有效的语音文件')
    const sendMechanism = await macWechatRuntimeManager.getSendMechanism()
    let sender = ''
    if (sendMechanism !== 'tm-message-source-send') {
      sender = await this.resolveMacSenderWxid()
      if (!sender) return fail('无法识别当前微信账号 wxid')
    }

    /* Reuse the Windows SILK preparation: it already normalizes any input to
     * SILK and reports the duration. */
    let temporaryVoicePath: string | undefined
    try {
      const prepared = await prepareWindowsVoiceFile(filePath)
      temporaryVoicePath = prepared.temporary ? prepared.filePath : undefined
      const silkData = readFileSync(prepared.filePath)
      const requestedDuration = Number(request.durationMs)
      const rawDuration =
        Number.isFinite(requestedDuration) && requestedDuration > 0
          ? requestedDuration
          : prepared.durationMs
      if (!rawDuration || !Number.isFinite(rawDuration)) {
        return fail('无法计算语音时长', 'duration')
      }
      const durationMs = Math.max(1, Math.min(60_000, Math.round(rawDuration)))
      logVoiceAttempt(requestId, 'prepared', {
        input_bytes: statSync(filePath).size,
        normalized_input_bytes: silkData.length,
        silk_duration_ms: durationMs
      })
      if (sendMechanism === 'tm-message-source-send') {
        if (durationMs < 1000) return fail('原生语音发送要求时长至少 1 秒', 'duration')
        const sent = await this.postMacHost(
          '/sendMsg',
          {
            type: 'voice',
            to: request.to,
            voice_hex: silkData.toString('hex'),
            duration_ms: durationMs
          },
          55_000
        )
        if (!sent?.ok) {
          return fail(sent?.message || '语音发送失败', 'send')
        }
        const status = await macWechatRuntimeManager.buildSenderStatus()
        logVoiceAttempt(requestId, 'completed', { send_result: '0' })
        return { success: true, status }
      }

      const upload = await this.postMacHost(
        '/uploadVoice',
        {
          to: request.to,
          filePath: prepared.filePath,
          audioDataHex: silkData.toString('hex'),
          voiceDurationMs: durationMs
        },
        30_000
      )
      if (!upload || !upload.ok) {
        return fail(upload?.message || '语音上传失败', 'upload')
      }
      const sent = await this.postMacHost('/sendVoice', { sender, to: request.to }, 50_000)
      if (!sent || !sent.ok) {
        return fail(sent?.message || '语音发送失败', 'send')
      }
      const status = await macWechatRuntimeManager.buildSenderStatus()
      logVoiceAttempt(requestId, 'completed', { send_result: '0' })
      return { success: true, status }
    } finally {
      if (temporaryVoicePath) {
        try {
          unlinkSync(temporaryVoicePath)
        } catch {
          // 临时语音只做尽力清理，清理失败不应覆盖真实发送结果。
        }
      }
    }
  }

  private async sendWindows(request: PersonalWechatSendRequest): Promise<PersonalWechatSendResult> {
    const to = String(request?.to || '').trim()
    if (!to) {
      const status = await this.getWindowsStatus()
      return { success: false, status, error: '接收者不能为空' }
    }
    if (request.type === 'text') {
      const text = String(request.text || '').trim()
      if (!text) {
        const status = await this.getWindowsStatus()
        return { success: false, status, error: '文字内容不能为空' }
      }
      if (text.length > 2_000) {
        const status = await this.getWindowsStatus()
        return { success: false, status, error: '文字内容不能超过 2000 个字符' }
      }
      request = { ...request, to, text }
    } else {
      const filePath = String(request.filePath || '').trim()
      if (!filePath || !existsSync(filePath)) {
        const status = await this.getWindowsStatus()
        return {
          success: false,
          status,
          error: `请选择有效的${request.type === 'voice' ? '语音' : '图片'}文件`
        }
      }
      const size = statSync(filePath).size
      if (size <= 0 || size > (request.type === 'voice' ? MAX_VOICE_BYTES : MAX_IMAGE_BYTES)) {
        const status = await this.getWindowsStatus()
        return {
          success: false,
          status,
          error: `${request.type === 'voice' ? '语音' : '图片'}必须小于 20 MB`
        }
      }
      request = { ...request, to, filePath }
    }

    let status = await this.getWindowsStatus()
    if (!status.canSend) {
      // hook 刚起来时第一次探测经常失败；短暂等待后复核一次，避免误报「未就绪」。
      await delay(600)
      status = await this.getWindowsStatus()
      if (!status.canSend) {
        return {
          success: false,
          status,
          error: status.error || status.message,
          errorCode: 'not_ready'
        }
      }
    }

    let attemptsTotal = 0
    let segments = 1
    let sentSegments = 0
    let temporaryImagePath: string | undefined
    let temporaryVoicePath: string | undefined
    const protocol: WechatHookProtocol = status.hookProtocol || 'trace-hook'
    const host = windowsHookHost()
    try {
      if (!host) throw new Error('尚未配置微信发送能力端口')
      if (request.type === 'text') {
        const parts = splitWechatText(request.text)
        segments = parts.length
        for (const part of parts) {
          if (protocol === 'wechat4-hook') attemptsTotal += 1
          const attempts = await this.submitHook(protocol, () =>
            sendTextViaHook(protocol, host, request.to, part)
          )
          if (protocol !== 'wechat4-hook') attemptsTotal += attempts
          sentSegments += 1
        }
      } else if (request.type === 'image') {
        const preparedImage = prepareWindowsImageFile(request.filePath, protocol === 'wechat4-hook')
        temporaryImagePath = preparedImage.temporary ? preparedImage.filePath : undefined
        // 关键证据：源文件有多大、是否走了临时副本、副本拷出来多大。
        // `copiedBytes < sourceBytes` ⇒ 截断的拷贝：拷贝中途失败不会抛错，
        // 只看「有没有文件」会漏掉这种情况。
        logSendDiagnostic('image-prepared', {
          sourceBytes: safeFileSize(request.filePath),
          usedTempCopy: preparedImage.temporary,
          copiedBytes: safeFileSize(preparedImage.filePath)
        })
        if (protocol === 'wechat4-hook') attemptsTotal += 1
        const attempts = await this.submitHook(protocol, () =>
          sendImageViaHook(protocol, host!, request.to, preparedImage.filePath, 60_000)
        )
        if (protocol !== 'wechat4-hook') attemptsTotal += attempts
        sentSegments = 1
      } else if (request.type === 'voice') {
        if (!hookSupportsVoice(protocol)) {
          throw new Error(
            `当前发送接口（${HOOK_PROTOCOL_LABELS[protocol]}）不支持语音，请改用 TraceMemo Hook 或改发文字/图片`
          )
        }
        const fromId = String(request.fromId || '').trim()
        if (!fromId) throw new Error('无法识别当前微信账号 wxid，无法发送语音')
        const preparedVoice = await prepareWindowsVoiceFile(request.filePath)
        temporaryVoicePath = preparedVoice.temporary ? preparedVoice.filePath : undefined
        const requestedDuration = Number(request.durationMs)
        const rawDuration =
          Number.isFinite(requestedDuration) && requestedDuration > 0
            ? requestedDuration
            : preparedVoice.durationMs
        if (!rawDuration || !Number.isFinite(rawDuration)) {
          throw new Error('无法计算语音时长，请重新生成或选择有效的 SILK 文件')
        }
        const durationMs = Math.max(1, Math.min(60_000, Math.round(rawDuration)))
        const windowsRequest = buildWindowsWechatRequest(request, {
          filePath: preparedVoice.filePath,
          durationMs
        })
        const result = await requestWindowsHookWithRetry(
          windowsRequest.endpoint,
          windowsRequest.body,
          60_000
        )
        attemptsTotal += result.attempts
        sentSegments = 1
      } else {
        const windowsRequest = buildWindowsWechatRequest(request)
        const result = await requestWindowsHookWithRetry(
          windowsRequest.endpoint,
          windowsRequest.body,
          60_000
        )
        attemptsTotal += result.attempts
        sentSegments = 1
      }
      return {
        success: true,
        status,
        ...(protocol === 'wechat4-hook' ? { deliveryStatus: 'accepted' as const } : {}),
        attempts: attemptsTotal,
        segments,
        sentSegments
      }
    } catch (error) {
      const classified = classifyWechatSendError(error)
      const partial =
        sentSegments > 0 && sentSegments < segments
          ? `（已发出 ${sentSegments}/${segments} 段）`
          : ''
      return {
        success: false,
        status: { ...status, state: 'error', error: classified.message },
        error:
          protocol === 'wechat4-hook'
            ? `提交未确认：${classified.message}${partial}。请先在微信核对，避免重复发送`
            : `发送失败：${classified.message}${partial}`,
        errorCode: classified.code,
        attempts: attemptsTotal,
        segments,
        sentSegments
      }
    } finally {
      if (temporaryImagePath) {
        const graceMs =
          protocol === 'wechat4-hook'
            ? Math.max(WINDOWS_TEMP_IMAGE_GRACE_MS, 10 * 60_000)
            : WINDOWS_TEMP_IMAGE_GRACE_MS
        if (graceMs > 0) {
          // 诊断模式：先不删，等一段时间再删（见常量注释）。
          const pending = temporaryImagePath
          setTimeout(() => {
            try {
              unlinkSync(pending)
            } catch {
              // best effort
            }
          }, graceMs).unref?.()
        } else {
          try {
            unlinkSync(temporaryImagePath)
          } catch {
            // Temporary files are best-effort cleanup only.
          }
        }
      }
      if (temporaryVoicePath) {
        try {
          unlinkSync(temporaryVoicePath)
        } catch {
          // Temporary files are best-effort cleanup only.
        }
      }
    }
  }
}

export const personalWechatSendService = new PersonalWechatSendService()

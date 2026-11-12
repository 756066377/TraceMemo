/**
 * Windows 微信发送 hook 的多协议适配层。
 *
 * TraceMemo 自带的是 `trace-hook` 契约（`/getLoginInfo` + `/SendMsg`），
 * 但这个契约只对应它自己的 hook；社区里能直接装的开源项目用的是别的路径。
 * 这里把三种都接上，发送前自动探测，避免「端口填对了却提示接口不存在」。
 *
 * 支持的协议（均来自公开文档）：
 *  - trace-hook：GET /getLoginInfo → {status:boolean}；POST /SendMsg {toWxid,type,msg} → {ret:0}
 *  - wxhelper   ：POST /api/checkLogin → {code:1}；POST /api/sendTextMsg {wxid,msg} → {code!=0}
 *                 https://github.com/ttttupup/wxhelper（默认端口 19088）
 *  - wcf-http   ：GET /login → {status:0}；POST /text {msg,receiver,aters} → {status:0}
 *                 https://github.com/yuxiaoli/wcf-http（默认端口 9999，底层 WeChatFerry）
 *  - wechat4-hook：GET /QueryDB/status → {IsLogin:1}；POST /SendTextMsg {wxidorgid,msg} → {ret:0}
 *                 本地配套组件（默认端口 30001，目标微信 4.1.15.56，需 wxinject 启动）
 *
 * 注意：wxhelper / wcf-http 只覆盖微信 3.9.x；微信 4.x 是重写架构，只有 wechat4-hook
 * 这类 version.dll 代理方案还在维护，且要严格匹配微信小版本。
 *
 * 本模块只发 HTTP，不注入、不读写微信进程内存；注入由用户自己装的那套 hook 负责。
 */

import type { WechatHookProtocolId } from '../../shared/personal-wechat'

export type WechatHookProtocol = WechatHookProtocolId

export const WECHAT_HOOK_PROTOCOLS: WechatHookProtocol[] = [
  'trace-hook',
  'wxhelper',
  'wcf-http',
  'wechat4-hook'
]

export const HOOK_PROTOCOL_LABELS: Record<WechatHookProtocol, string> = {
  'trace-hook': 'TraceMemo Hook（/SendMsg）',
  wxhelper: 'wxhelper（/api/sendTextMsg）',
  'wcf-http': 'wcf-http（/text）',
  'wechat4-hook': 'WeChat-Hook 4.x（/SendTextMsg）'
}

export const HOOK_PROTOCOL_DEFAULT_PORTS: Record<WechatHookProtocol, string[]> = {
  'trace-hook': [],
  wxhelper: ['19088'],
  'wcf-http': ['9999'],
  'wechat4-hook': ['30001']
}

export interface HookProbeResult {
  protocol: WechatHookProtocol
  loggedIn: boolean
  loginState?: 'logged_in' | 'logged_out' | 'unknown'
  loginError?: string
  detail?: string
}

export class HookCallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string
  ) {
    super(message)
    this.name = 'HookCallError'
  }
}

const PROBE_TIMEOUT_MS = 1_200
export const WECHAT4_SEND_SUSPENDED_REASON =
  '微信 4.x 原生发送在消息提交后可能触发微信崩溃，当前已暂停文字和图片发送。登录检测仍可使用；已经发出的消息请勿重发。'

function requireSendingAvailable(protocol: WechatHookProtocol): void {
  if (protocol === 'wechat4-hook') throw new HookCallError(WECHAT4_SEND_SUSPENDED_REASON)
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ status: number; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(300, timeoutMs))
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    return { status: response.status, text }
  } finally {
    clearTimeout(timer)
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function jsonBody(payload: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload)
  }
}

/** 逐个协议探测；返回第一个「接口存在」的结果（未登录也算命中，便于提示先登录）。 */
export async function probeHook(
  host: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<HookProbeResult | null> {
  for (const protocol of WECHAT_HOOK_PROTOCOLS) {
    const result = await probeProtocol(protocol, host, timeoutMs)
    if (result) return result
  }
  return null
}

export async function probeProtocol(
  protocol: WechatHookProtocol,
  host: string,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<HookProbeResult | null> {
  try {
    if (protocol === 'trace-hook') {
      const { status, text } = await request(
        `http://${host}/getLoginInfo`,
        { method: 'GET', headers: { accept: 'application/json' } },
        timeoutMs
      )
      if (status < 200 || status >= 300) return null
      const payload = parseJson(text)
      // 只有布尔 status 才算 trace-hook，避免和 wcf-http 的数字 status 混淆。
      if (!payload || typeof payload.status !== 'boolean') return null
      return { protocol, loggedIn: payload.status === true, detail: text.slice(0, 120) }
    }
    if (protocol === 'wxhelper') {
      const { status, text } = await request(
        `http://${host}/api/checkLogin`,
        jsonBody({}),
        timeoutMs
      )
      if (status < 200 || status >= 300) return null
      const payload = parseJson(text)
      if (!payload || typeof payload.code !== 'number' || typeof payload.msg !== 'string')
        return null
      return { protocol, loggedIn: payload.code === 1, detail: text.slice(0, 120) }
    }
    if (protocol === 'wechat4-hook') {
      const { status, text } = await request(
        `http://${host}/QueryDB/status`,
        { method: 'GET', headers: { accept: 'application/json' } },
        timeoutMs
      )
      if (status < 200 || status >= 300) return null
      const payload = parseJson(text)
      if (!payload || typeof payload.IsLogin !== 'number') return null
      if (payload.loginDetection === 'account-memory-v1') {
        const loginState =
          payload.ret === 0 && payload.IsLogin === 1 && payload.loginState === 'logged_in'
            ? 'logged_in'
            : payload.ret === 0 && payload.IsLogin === 0 && payload.loginState === 'logged_out'
              ? 'logged_out'
              : 'unknown'
        return {
          protocol,
          loggedIn: loginState === 'logged_in',
          loginState,
          ...(loginState === 'unknown'
            ? {
                loginError:
                  typeof payload.retmsg === 'string'
                    ? payload.retmsg.slice(0, 200)
                    : '登录检测响应不一致'
              }
            : {}),
          detail: text.slice(0, 120)
        }
      }
      return { protocol, loggedIn: payload.IsLogin === 1, detail: text.slice(0, 120) }
    }
    const { status, text } = await request(
      `http://${host}/login`,
      { method: 'GET', headers: { accept: 'application/json' } },
      timeoutMs
    )
    if (status < 200 || status >= 300) return null
    const payload = parseJson(text)
    if (!payload || typeof payload.status !== 'number') return null
    return { protocol, loggedIn: payload.status === 0, detail: text.slice(0, 120) }
  } catch {
    return null
  }
}

/** 发送文本；失败抛 HookCallError，由上层翻成用户能懂的 errorCode。 */
export async function sendTextViaHook(
  protocol: WechatHookProtocol,
  host: string,
  toWxid: string,
  text: string,
  timeoutMs = 20_000
): Promise<void> {
  requireSendingAvailable(protocol)
  if (protocol === 'wxhelper') {
    const { status, text: body } = await request(
      `http://${host}/api/sendTextMsg`,
      jsonBody({ wxid: toWxid, msg: text }),
      timeoutMs
    )
    const payload = parseJson(body)
    // 文档约定：code 不为 0 表示成功。
    if (status >= 400 || !payload || payload.code === 0) {
      throw new HookCallError(hookFailure('wxhelper', payload, body), status, body)
    }
    return
  }
  if (protocol === 'wcf-http') {
    const { status, text: body } = await request(
      `http://${host}/text`,
      jsonBody({ msg: text, receiver: toWxid, aters: '' }),
      timeoutMs
    )
    const payload = parseJson(body)
    if (status >= 400 || !payload || payload.status !== 0) {
      throw new HookCallError(hookFailure('wcf-http', payload, body), status, body)
    }
    return
  }
  if (protocol === 'wechat4-hook') {
    const { status, text: body } = await request(
      `http://${host}/SendTextMsg`,
      jsonBody({ wxidorgid: toWxid, msg: text }),
      timeoutMs
    )
    const payload = parseJson(body)
    if (status >= 400 || !payload || payload.ret !== 0) {
      throw new HookCallError(hookFailure('wechat4-hook', payload, body), status, body)
    }
    return
  }
  const { status, text: body } = await request(
    `http://${host}/SendMsg`,
    jsonBody({ toWxid, type: 'text', msg: text }),
    timeoutMs
  )
  const payload = parseJson(body)
  if (status >= 400 || !payload || payload.ret !== 0) {
    throw new HookCallError(hookFailure('trace-hook', payload, body), status, body)
  }
}

/** 发送图片；trace-hook 之外的两种协议都支持本地路径。 */
export async function sendImageViaHook(
  protocol: WechatHookProtocol,
  host: string,
  toWxid: string,
  filePath: string,
  timeoutMs = 60_000
): Promise<void> {
  requireSendingAvailable(protocol)
  if (protocol === 'wxhelper') {
    const { status, text: body } = await request(
      `http://${host}/api/sendImagesMsg`,
      jsonBody({ wxid: toWxid, imagePath: filePath }),
      timeoutMs
    )
    const payload = parseJson(body)
    if (status >= 400 || !payload || payload.code === 0) {
      throw new HookCallError(hookFailure('wxhelper', payload, body), status, body)
    }
    return
  }
  if (protocol === 'wcf-http') {
    const { status, text: body } = await request(
      `http://${host}/image`,
      jsonBody({ path: filePath, receiver: toWxid }),
      timeoutMs
    )
    const payload = parseJson(body)
    if (status >= 400 || !payload || payload.status !== 0) {
      throw new HookCallError(hookFailure('wcf-http', payload, body), status, body)
    }
    return
  }
  if (protocol === 'wechat4-hook') {
    const { status, text: body } = await request(
      `http://${host}/SendImgMsg`,
      jsonBody({ wxidorgid: toWxid, path: filePath }),
      timeoutMs
    )
    const payload = parseJson(body)
    if (status >= 400 || !payload || payload.ret !== 0) {
      throw new HookCallError(hookFailure('wechat4-hook', payload, body), status, body)
    }
    return
  }
  const { status, text: body } = await request(
    `http://${host}/SendMsg`,
    jsonBody({ toWxid, type: 'image', msg: filePath }),
    timeoutMs
  )
  const payload = parseJson(body)
  if (status >= 400 || !payload || payload.ret !== 0) {
    throw new HookCallError(hookFailure('trace-hook', payload, body), status, body)
  }
}

/** 语音只有 trace-hook 契约支持；其他协议的 hook 没有统一接口。 */
export function hookSupportsVoice(protocol: WechatHookProtocol): boolean {
  return protocol === 'trace-hook'
}

function hookFailure(
  protocol: WechatHookProtocol,
  payload: Record<string, unknown> | null,
  body: string
): string {
  const detail =
    (payload && (payload.msg ?? payload.retmsg ?? payload.message ?? payload.error)) || body
  const suffix =
    protocol === 'wechat4-hook'
      ? '（微信 4.x 的 hook 必须与微信小版本严格对应；升级过微信就要换对应版本的 DLL）'
      : ''
  return `${HOOK_PROTOCOL_LABELS[protocol]} 返回失败：${String(detail).slice(0, 200)}${suffix}`
}

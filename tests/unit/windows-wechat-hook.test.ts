import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HookCallError,
  hookSupportsVoice,
  probeHook,
  probeProtocol,
  sendImageViaHook,
  sendTextViaHook
} from '../../src/main/services/windows-wechat-hook'

interface Call {
  url: string
  method: string
  body?: string
}

function stubFetch(
  handler: (call: Call) => { status: number; body: string } | Promise<never>
): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: String(init?.method || 'GET'),
        body: typeof init?.body === 'string' ? init.body : undefined
      }
      calls.push(call)
      const result = handler(call)
      if (result instanceof Promise) return result
      return new Response(result.body, {
        status: result.status,
        headers: { 'content-type': 'application/json' }
      })
    })
  )
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe('发送 hook 协议探测', () => {
  it('识别 trace-hook：/getLoginInfo 返回布尔 status', async () => {
    stubFetch(() => ({ status: 200, body: '{"status":true}' }))
    const probe = await probeHook('127.0.0.1:9999')
    expect(probe).toMatchObject({ protocol: 'trace-hook', loggedIn: true })
  })

  it('识别 wxhelper：/api/checkLogin 返回 code=1', async () => {
    stubFetch((call) => {
      if (call.url.endsWith('/getLoginInfo')) return { status: 404, body: '' }
      return { status: 200, body: '{"code":1,"msg":"success","data":null}' }
    })
    const probe = await probeHook('127.0.0.1:19088')
    expect(probe).toMatchObject({ protocol: 'wxhelper', loggedIn: true })
  })

  it('识别 wcf-http：/login 返回数字 status=0', async () => {
    stubFetch((call) => {
      if (call.url.endsWith('/getLoginInfo')) return { status: 404, body: '' }
      if (call.url.endsWith('/api/checkLogin')) return { status: 404, body: '' }
      return { status: 200, body: '{"status":0,"message":"成功"}' }
    })
    const probe = await probeHook('127.0.0.1:9999')
    expect(probe).toMatchObject({ protocol: 'wcf-http', loggedIn: true })
  })

  it('识别 wechat4-hook：/QueryDB/status 返回 IsLogin=1', async () => {
    stubFetch((call) => {
      if (call.url.endsWith('/QueryDB/status'))
        return { status: 200, body: JSON.stringify({ IsLogin: 1, hWeixin: 123 }) }
      return { status: 404, body: '' }
    })
    const probe = await probeHook('127.0.0.1:30001')
    expect(probe).toMatchObject({ protocol: 'wechat4-hook', loggedIn: true })
  })

  it('三种协议都探测不到时返回 null', async () => {
    stubFetch(() => ({ status: 404, body: '{"detail":"not found"}' }))
    expect(await probeHook('127.0.0.1:65000')).toBeNull()
  })

  it('wxhelper 未登录（code=0）不会被误判为已登录', async () => {
    stubFetch(() => ({ status: 200, body: '{"code":0,"msg":"fail"}' }))
    const probe = await probeProtocol('wxhelper', '127.0.0.1:19088')
    expect(probe).toMatchObject({ protocol: 'wxhelper', loggedIn: false })
  })

  it.each([
    [{ IsLogin: 1, loginState: 'logged_in', ret: 0 }, true, 'logged_in'],
    [{ IsLogin: 0, loginState: 'logged_out', ret: 0 }, false, 'logged_out'],
    [{ IsLogin: -1, loginState: 'unknown', ret: -1, retmsg: 'layout mismatch' }, false, 'unknown'],
    [{ IsLogin: 1, loginState: 'logged_in', ret: -1 }, false, 'unknown'],
    [{ IsLogin: 1, loginState: 'logged_out', ret: 0 }, false, 'unknown']
  ] as const)('新版组件状态与返回码必须一致：%j', async (payload, loggedIn, loginState) => {
    stubFetch(() => ({
      status: 200,
      body: JSON.stringify({ ...payload, loginDetection: 'account-memory-v1' })
    }))
    expect(await probeProtocol('wechat4-hook', '127.0.0.1:30001')).toMatchObject({
      loggedIn,
      loginState
    })
  })
})

describe('发送请求构造', () => {
  it('trace-hook 用 /SendMsg + toWxid/type/msg', async () => {
    const calls = stubFetch(() => ({ status: 200, body: '{"ret":0,"retmsg":"success"}' }))
    await sendTextViaHook('trace-hook', '127.0.0.1:9999', 'wxid_a', '你好')
    expect(calls[0].url).toBe('http://127.0.0.1:9999/SendMsg')
    expect(JSON.parse(calls[0].body as string)).toEqual({
      toWxid: 'wxid_a',
      type: 'text',
      msg: '你好'
    })
  })

  it('wxhelper 用 /api/sendTextMsg + wxid/msg，code=0 视为失败', async () => {
    const calls = stubFetch(() => ({ status: 200, body: '{"code":0,"msg":"fail"}' }))
    await expect(sendTextViaHook('wxhelper', '127.0.0.1:19088', 'wxid_a', '你好')).rejects.toThrow(
      HookCallError
    )
    expect(calls[0].url).toBe('http://127.0.0.1:19088/api/sendTextMsg')
    expect(JSON.parse(calls[0].body as string)).toEqual({ wxid: 'wxid_a', msg: '你好' })
  })

  it('wcf-http 用 /text + msg/receiver，status=0 视为成功', async () => {
    const calls = stubFetch(() => ({ status: 200, body: '{"status":0,"message":"成功"}' }))
    await sendTextViaHook('wcf-http', '127.0.0.1:9999', 'filehelper', '你好')
    expect(calls[0].url).toBe('http://127.0.0.1:9999/text')
    expect(JSON.parse(calls[0].body as string)).toEqual({
      msg: '你好',
      receiver: 'filehelper',
      aters: ''
    })
  })

  it('wechat4-hook 崩溃修复验证前禁止文本与图片请求', async () => {
    const calls = stubFetch(() => ({ status: 200, body: '{"ret":0,"retmsg":"success"}' }))
    await expect(
      sendTextViaHook('wechat4-hook', '127.0.0.1:30001', 'wxid_a', '你好')
    ).rejects.toThrow('已暂停')
    await expect(
      sendImageViaHook('wechat4-hook', '127.0.0.1:30001', 'wxid_a', 'C:\\pic.png')
    ).rejects.toThrow('已暂停')
    expect(calls).toHaveLength(0)
  })

  it('wechat4-hook 失败（ret!=0）会抛错', async () => {
    stubFetch(() => ({ status: 200, body: '{"ret":1,"retmsg":"fail"}' }))
    await expect(
      sendTextViaHook('wechat4-hook', '127.0.0.1:30001', 'wxid_a', '你好')
    ).rejects.toThrow(HookCallError)
  })

  it('图片按协议走不同路径', async () => {
    const calls = stubFetch(() => ({ status: 200, body: '{"status":0,"code":1}' }))
    await sendImageViaHook('wxhelper', '127.0.0.1:19088', 'wxid_a', 'C:\\pic.png')
    expect(calls[0].url).toBe('http://127.0.0.1:19088/api/sendImagesMsg')
    expect(JSON.parse(calls[0].body as string)).toEqual({
      wxid: 'wxid_a',
      imagePath: 'C:\\pic.png'
    })
  })

  it('只有 trace-hook 支持语音', () => {
    expect(hookSupportsVoice('trace-hook')).toBe(true)
    expect(hookSupportsVoice('wxhelper')).toBe(false)
    expect(hookSupportsVoice('wcf-http')).toBe(false)
  })
})

import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({ windowsWechatPort: '' }))
vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/fixture/app',
    getPath: () => '/tmp/tracememo-hook-test',
    isPackaged: false
  }
}))
vi.mock('../../src/main/services/settings-store', () => ({ loadSettings: () => settings }))

import { PersonalWechatSendService } from '../../src/main/services/personal-wechat-send-service'
import {
  probeProtocol,
  sendImageViaHook,
  sendTextViaHook
} from '../../src/main/services/windows-wechat-hook'

describe('微信 4.x 崩溃后的发送隔离与登录检测', () => {
  let server: Server
  let loggedIn = true
  let loginReadable = true
  let legacyStatus = false
  let statusCode = 200
  let sendRequests = 0
  let statusRequests = 0
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeAll(async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    server = createServer((request, response) => {
      if (request.url === '/QueryDB/status') {
        statusRequests++
        response.writeHead(statusCode, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify(
            legacyStatus
              ? { IsLogin: loggedIn ? 1 : 0 }
              : {
                  IsLogin: loginReadable ? (loggedIn ? 1 : 0) : -1,
                  loginState: loginReadable ? (loggedIn ? 'logged_in' : 'logged_out') : 'unknown',
                  loginDetection: 'account-memory-v1',
                  componentBuild: '4.1.15.56-send-suspended-v2',
                  sendReady: false,
                  ret: loginReadable ? 0 : -1,
                  retmsg: loginReadable ? 'success' : 'account unavailable'
                }
          )
        )
        return
      }
      if (request.url === '/SendTextMsg' || request.url === '/SendImgMsg') {
        sendRequests++
        request.resume()
        // Detect an accidental POST even when a legacy component reports success.
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ret":0}')
        return
      }
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    settings.windowsWechatPort = String((server.address() as { port: number }).port)
  })
  beforeEach(() => {
    loggedIn = true
    loginReadable = true
    legacyStatus = false
    statusCode = 200
    sendRequests = 0
    statusRequests = 0
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  it('已登录只证明登录，不能启用已知崩溃的发送实现', async () => {
    const host = `127.0.0.1:${settings.windowsWechatPort}`
    expect(await probeProtocol('wechat4-hook', host)).toMatchObject({
      loggedIn: true,
      loginState: 'logged_in'
    })
    expect(
      await new PersonalWechatSendService().checkWindowsStatus(settings.windowsWechatPort)
    ).toMatchObject({
      endpointReady: true,
      canSend: false,
      canSendText: false,
      canSendImage: false,
      loginState: 'logged_in',
      message: '微信已登录 · 发送已暂停'
    })
    expect(statusRequests).toBeGreaterThan(0)
  })

  it('直接调用适配层的文本和图片发送也不会访问旧组件', async () => {
    const host = `127.0.0.1:${settings.windowsWechatPort}`
    await expect(sendTextViaHook('wechat4-hook', host, 'fixture', 'test')).rejects.toThrow('已暂停')
    await expect(sendImageViaHook('wechat4-hook', host, 'fixture', 'fixture.png')).rejects.toThrow(
      '已暂停'
    )
    expect(sendRequests).toBe(0)
  })

  it('主进程拒绝个人和群聊发送，不因旧组件声称成功而放行', async () => {
    legacyStatus = true
    const sender = new PersonalWechatSendService()
    for (const to of ['fixture', 'fixture@chatroom']) {
      const result = await sender.send({
        to,
        isGroup: to.endsWith('@chatroom'),
        type: 'text',
        text: 'test'
      })
      expect(result).toMatchObject({ success: false, errorCode: 'not_ready' })
      expect(result.error).toContain('已暂停')
    }
    expect(sendRequests).toBe(0)
  })

  it('未登录、未知、重新登录的转换仍被识别，重登不解除暂停', async () => {
    const sender = new PersonalWechatSendService()
    loggedIn = false
    expect(await sender.checkWindowsStatus(settings.windowsWechatPort)).toMatchObject({
      endpointReady: true,
      canSend: false,
      loginState: 'logged_out'
    })
    loginReadable = false
    const unknown = await sender.checkWindowsStatus(settings.windowsWechatPort)
    expect(unknown).toMatchObject({ endpointReady: true, canSend: false, loginState: 'unknown' })
    expect(unknown.error).toContain('account unavailable')
    loggedIn = true
    loginReadable = true
    expect(await sender.checkWindowsStatus(settings.windowsWechatPort)).toMatchObject({
      endpointReady: true,
      canSend: false,
      loginState: 'logged_in'
    })
    expect(sendRequests).toBe(0)
  })

  it('HTTP 错误响应不能被视为已登录', async () => {
    statusCode = 403
    expect(
      await probeProtocol('wechat4-hook', `127.0.0.1:${settings.windowsWechatPort}`)
    ).toBeNull()
  })
})

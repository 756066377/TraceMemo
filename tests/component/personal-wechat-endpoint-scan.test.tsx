import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonalWechatSendPage } from '../../src/renderer/src/features/settings/pages/PersonalWechatSendPage'
import type { PersonalWechatSenderStatus } from '../../src/shared/personal-wechat'

vi.mock('../../src/renderer/src/utils/runtime-environment', () => ({
  isMac: false,
  isWindows: true,
  runtimePlatform: 'win32',
  supportsPersonalWechatSend: true
}))

const onlineStatus: PersonalWechatSenderStatus = {
  state: 'online',
  platform: 'win32',
  arch: 'x64',
  sipDisabled: true,
  wechatRunning: true,
  endpoint: '127.0.0.1:9999',
  endpointReady: true,
  runtimeReady: true,
  attachReady: true,
  baseAddressReady: true,
  textHookInstalled: true,
  textHookReady: true,
  imageHookInstalled: true,
  imageHookReady: true,
  messageListenerReady: true,
  canSend: true,
  canSendText: true,
  canSendImage: true,
  canSendVoice: true,
  message: 'Windows 微信发送能力已连接，可以发送消息'
}

describe('Windows 发送接口端口', () => {
  let scanPersonalWechatEndpoint: ReturnType<typeof vi.fn>
  let checkPersonalWechatSenderStatus: ReturnType<typeof vi.fn>
  let setSettings: ReturnType<typeof vi.fn>

  beforeEach(() => {
    scanPersonalWechatEndpoint = vi.fn().mockResolvedValue({
      success: true,
      scanned: 12,
      candidates: [{ port: '9999', matched: true, status: 200, detail: '{"status":true}' }],
      bestPort: '9999'
    })
    checkPersonalWechatSenderStatus = vi.fn().mockResolvedValue(onlineStatus)
    setSettings = vi.fn().mockResolvedValue({ success: true })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue({ settings: { windowsWechatPort: '' } }),
        getPersonalWechatSenderStatus: vi.fn().mockResolvedValue({
          ...onlineStatus,
          state: 'error',
          canSend: false,
          canSendText: false,
          endpointReady: false,
          message: '尚未配置微信发送能力端口'
        }),
        scanPersonalWechatEndpoint,
        checkPersonalWechatSenderStatus,
        setSettings
      } as unknown as typeof window.api
    })
  })

  it('说明端口的来源，避免把 TraceMemo 当成自带 hook', async () => {
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)
    // 端口说明必须指明来自本机另装的发送 hook，并列出已知协议端口。
    expect(await screen.findByText(/端口来自本机另装的发送 hook/)).toBeVisible()
    expect(screen.getByText(/扫描会按协议自动识别/)).toBeVisible()
  })

  it('扫描到端口后自动填入并检测，保存前不写配置', async () => {
    const user = userEvent.setup()
    const onNotice = vi.fn()
    render(<PersonalWechatSendPage onNotice={onNotice} />)

    await user.click(await screen.findByRole('button', { name: '扫描本机端口' }))

    await waitFor(() => expect(scanPersonalWechatEndpoint).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByLabelText('微信发送能力端口')).toHaveValue(9999))
    expect(checkPersonalWechatSenderStatus).toHaveBeenCalledWith('9999')
    expect(await screen.findByText(/端口 9999 可用/)).toBeVisible()
    expect(document.querySelector('.wechat-send-header-actions')).toHaveTextContent('待保存')
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled()
    expect(setSettings).not.toHaveBeenCalled()
  })

  it('扫描不到时给出「没有发送 hook」的明确结论', async () => {
    scanPersonalWechatEndpoint.mockResolvedValue({
      success: true,
      scanned: 32,
      candidates: [{ port: '7890', matched: false, status: 400 }]
    })
    const user = userEvent.setup()
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: '扫描本机端口' }))

    expect(await screen.findByText(/没有找到发送接口/)).toBeVisible()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('接口正常但登录未确认时允许保存端口，不误报发送就绪', async () => {
    const status = {
      ...onlineStatus,
      state: 'hook_not_ready',
      canSend: false,
      canSendText: false,
      canSendImage: false,
      canSendVoice: false,
      message: '接口已连接，组件尚未确认登录'
    }
    checkPersonalWechatSenderStatus.mockResolvedValue(status)
    window.api.getPersonalWechatSenderStatus = vi.fn().mockResolvedValue(status)
    const user = userEvent.setup()
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)
    await user.type(await screen.findByLabelText('微信发送能力端口'), '30001')
    await user.click(screen.getByRole('button', { name: /^检测$/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled())
    expect(document.querySelector('.wechat-send-header-actions')).toHaveTextContent('待保存')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(setSettings).toHaveBeenCalledWith({ windowsWechatPort: '30001' })
    expect(await screen.findByText('组件尚未确认登录', { exact: false })).toBeVisible()
    expect(document.querySelector('.wechat-send-header-actions')).not.toHaveTextContent('已就绪')
  })
})

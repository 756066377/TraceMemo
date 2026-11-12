import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PersonalWechatSendPage } from '../../src/renderer/src/features/settings/pages/PersonalWechatSendPage'
import type { WechatHookComponentStatus } from '../../src/shared/personal-wechat'

vi.mock('../../src/renderer/src/utils/runtime-environment', () => ({
  isMac: false,
  isWindows: true,
  runtimePlatform: 'win32',
  supportsPersonalWechatSend: true
}))

const emptyHookStatus: WechatHookComponentStatus = {
  platform: 'win32',
  wechat: {
    detected: true,
    version: '4.1.10.27',
    installDir: 'C:\\Program Files\\Tencent\\Weixin',
    processName: 'Weixin',
    running: false
  },
  installed: false,
  installedMatchesComponent: false,
  backupExists: false,
  supportedVersions: [],
  versionSupported: false,
  canInject: false,
  reasons: ['还没有可用的 Hook 组件（安装包未内置，也没有导入）']
}

describe('微信发送设置页的 Hook 注入', () => {
  let pickAndInjectWechatHook: ReturnType<typeof vi.fn>
  let installWechatHook: ReturnType<typeof vi.fn>
  let getWechatHookComponentStatus: ReturnType<typeof vi.fn>

  beforeEach(() => {
    pickAndInjectWechatHook = vi.fn().mockResolvedValue({
      success: true,
      steps: ['组件已保存到用户目录', '已写入 C:\\Program Files\\Tencent\\Weixin\\version.dll']
    })
    installWechatHook = vi.fn().mockResolvedValue({ success: true, steps: ['已写入 version.dll'] })
    getWechatHookComponentStatus = vi.fn().mockResolvedValue(emptyHookStatus)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSettings: vi.fn().mockResolvedValue({ settings: { windowsWechatPort: '' } }),
        getPersonalWechatSenderStatus: vi.fn().mockResolvedValue({
          state: 'error',
          platform: 'win32',
          canSend: false,
          canSendText: false,
          endpointReady: false,
          message: '尚未配置微信发送能力端口'
        }),
        checkPersonalWechatSenderStatus: vi.fn(),
        scanPersonalWechatEndpoint: vi
          .fn()
          .mockResolvedValue({ success: true, scanned: 0, candidates: [] }),
        getWechatHookComponentStatus,
        pickAndInjectWechatHook,
        installWechatHook,
        closeWechatForHook: vi.fn().mockResolvedValue({ success: true }),
        uninstallWechatHook: vi.fn().mockResolvedValue({ success: true, steps: [] })
      } as unknown as typeof window.api
    })
  })

  it('没有可用组件时，点主按钮直接走「选文件 + 直接注入」，不再需要第二次点击', async () => {
    const user = userEvent.setup()
    const onNotice = vi.fn()
    render(<PersonalWechatSendPage onNotice={onNotice} />)

    const button = await screen.findByRole('button', { name: '选择 DLL 并注入' })
    await user.click(button)

    await waitFor(() => expect(pickAndInjectWechatHook).toHaveBeenCalledTimes(1))
    expect(installWechatHook).not.toHaveBeenCalled()
    expect(await screen.findByText(/已写入 C:\\Program Files/)).toBeVisible()
    expect(onNotice).toHaveBeenCalledWith('Hook 组件已注入，重启微信后生效')
  })

  it('已有可用组件时，主按钮直接注入，不弹文件选择', async () => {
    getWechatHookComponentStatus.mockResolvedValue({
      ...emptyHookStatus,
      dll: {
        path: 'C:\\Users\\Mason\\AppData\\Roaming\\TraceMemo\\wechat-hook\\version.dll',
        size: 4096,
        sha256: 'abc',
        machine: 'x64',
        source: 'imported',
        wechatVersions: ['4.1.15.56']
      },
      versionSupported: true,
      canInject: true,
      reasons: []
    })
    const user = userEvent.setup()
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    const button = await screen.findByRole('button', { name: '注入到微信' })
    await user.click(button)

    await waitFor(() => expect(installWechatHook).toHaveBeenCalledTimes(1))
    expect(pickAndInjectWechatHook).not.toHaveBeenCalled()
  })

  it('版本不匹配时主按钮默认禁用，勾选强制后才可注入', async () => {
    getWechatHookComponentStatus.mockResolvedValue({
      ...emptyHookStatus,
      dll: {
        path: 'C:\\Users\\Mason\\AppData\\Roaming\\TraceMemo\\wechat-hook\\version.dll',
        size: 4096,
        sha256: 'abc',
        machine: 'x64',
        source: 'imported',
        wechatVersions: ['4.1.10.27']
      },
      versionSupported: false,
      reasons: ['组件未声明支持微信 4.1.15.56']
    })
    const user = userEvent.setup()
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    const button = await screen.findByRole('button', { name: '注入到微信' })
    expect(button).toBeDisabled()

    await user.click(screen.getByLabelText('版本不匹配也强制尝试'))
    await waitFor(() => expect(button).toBeEnabled())
  })

  it('设置页提供新版适配说明，不再错误下载旧版安装包', async () => {
    const openWechatHookWechatDownload = vi.fn().mockResolvedValue({ success: true })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...(window.api as unknown as Record<string, unknown>),
        openWechatHookWechatDownload
      } as unknown as typeof window.api
    })
    const user = userEvent.setup()
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    expect(await screen.findByText('仅适配 4.1.15.56', { exact: true })).toBeVisible()
    await user.click(await screen.findByRole('button', { name: '查看适配说明' }))

    await waitFor(() => expect(openWechatHookWechatDownload).toHaveBeenCalledTimes(1))
  })

  it('「注入到运行中的微信」成功后自动填入 hook 端口并检测', async () => {
    const injectRunningWechatHook = vi.fn().mockResolvedValue({
      success: true,
      steps: ['已定位微信主进程 pid=8832', '已注入 version.dll', 'hook 已就绪'],
      port: '30001'
    })
    const checkPersonalWechatSenderStatus = vi.fn().mockResolvedValue({
      state: 'online',
      platform: 'win32',
      canSend: true,
      canSendText: true,
      canSendImage: false,
      canSendVoice: false,
      endpointReady: true,
      message: 'Windows 微信发送能力已连接，可以发送消息'
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...(window.api as unknown as Record<string, unknown>),
        injectRunningWechatHook,
        checkPersonalWechatSenderStatus
      } as unknown as typeof window.api
    })

    const user = userEvent.setup()
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: '注入到运行中的微信' }))

    await waitFor(() => expect(injectRunningWechatHook).toHaveBeenCalledWith({ force: false }))
    await waitFor(() => expect(checkPersonalWechatSenderStatus).toHaveBeenCalledWith('30001'))
    expect(await screen.findByLabelText('微信发送能力端口')).toHaveValue(30001)
    expect(await screen.findByText(/hook 已就绪/)).toBeVisible()
  })

  it('新版启动微信并检测登录状态，不调用旧安装或退出接口', async () => {
    getWechatHookComponentStatus.mockResolvedValue({
      ...emptyHookStatus,
      wechat: { ...emptyHookStatus.wechat, version: '4.1.15.56' },
      versionSupported: true,
      reasons: []
    })
    const start = vi
      .fn()
      .mockResolvedValue({
        success: true,
        steps: ['接口已连接，请登录微信'],
        port: '30001',
        loggedIn: false
      })
    const check = vi.fn().mockResolvedValue({
      state: 'hook_not_ready',
      endpointReady: true,
      canSend: false,
      message: '等待登录'
    })
    Object.assign(window.api, {
      startWechatWithHook: start,
      checkPersonalWechatSenderStatus: check
    })
    const user = userEvent.setup()
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: '启动微信并连接' }))
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    expect(check).toHaveBeenCalledWith('30001')
    expect(window.api.closeWechatForHook).not.toHaveBeenCalled()
    expect(installWechatHook).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '注入到运行中的微信' })).not.toBeInTheDocument()
  })

  it('新版版本不匹配时不能强制启动', async () => {
    getWechatHookComponentStatus.mockResolvedValue({
      ...emptyHookStatus,
      wechat: { ...emptyHookStatus.wechat, version: '4.1.15.55' }
    })
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)
    expect(await screen.findByRole('button', { name: '启动微信并连接' })).toBeDisabled()
    expect(screen.queryByLabelText('版本不匹配也强制尝试')).not.toBeInTheDocument()
  })
})

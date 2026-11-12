import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PersonalWechatSetupGuide } from '../../src/renderer/src/components/chat/PersonalWechatSetupGuide'
import { PersonalWechatSendPage } from '../../src/renderer/src/features/settings/pages/PersonalWechatSendPage'
import type { PersonalWechatSenderStatus } from '../../src/shared/personal-wechat'

vi.mock('../../src/renderer/src/utils/runtime-environment', () => ({
  isMac: true,
  isWindows: false,
  runtimePlatform: 'darwin',
  supportsPersonalWechatSend: true
}))

const unavailableStatus: PersonalWechatSenderStatus = {
  state: 'runtime_missing',
  platform: 'darwin',
  arch: 'arm64',
  sipDisabled: true,
  wechatRunning: false,
  endpoint: 'http://127.0.0.1:4290',
  endpointReady: false,
  runtimeReady: false,
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
  message: '暂无发送能力',
  error: '暂无发送能力'
}

describe('personal WeChat unavailable product state', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getMacSendRuntimeAvailability: vi.fn(async () => ({
          state: 'available',
          message: '微信发送组件可用'
        })),
        getPersonalWechatSendCapability: vi.fn(async () => ({
          supported: true,
          ready: false,
          status: 'unconfigured',
          capabilities: { text: false, image: false, voice: false },
          senderStatus: unavailableStatus,
          message: '暂无发送能力',
          error: '暂无发送能力'
        })),
        getPersonalWechatSenderStatus: vi.fn(async () => unavailableStatus),
        getMacLicenseStatus: vi.fn(async () => ({
          deviceId: `mac_${'c'.repeat(64)}`,
          state: 'unlicensed',
          authorized: false,
          source: 'none',
          features: [],
          lastCheckedAt: null,
          licenseExpiresAt: null,
          tokenExpiresAt: null,
          message: '当前设备暂无发送能力授权'
        })),
        refreshMacLicense: vi.fn()
      }
    })
  })

  it('keeps the setup flow visible and disables binding when the runtime is unavailable', () => {
    render(
      <PersonalWechatSetupGuide
        senderStatus={unavailableStatus}
        binding={false}
        detecting={false}
        sessionBound={false}
        onBind={vi.fn()}
        onStartSending={vi.fn()}
      />
    )

    expect(screen.getByRole('heading', { name: '先准备好微信消息功能' })).toBeVisible()
    expect(screen.getByRole('button', { name: '绑定微信' })).toBeDisabled()
    expect(screen.queryByText(/发送能力属授权制|联系群主/)).toBeNull()
    expect(screen.getByText(/发送运行时未就绪/)).toBeVisible()
    expect(screen.queryByRole('link', { name: '这里' })).toBeNull()
    expect(screen.queryByRole('button', { name: '下载运行时' })).not.toBeInTheDocument()
    expect(screen.queryByText('查看支持的微信版本')).not.toBeInTheDocument()
    expect(screen.queryByText('高级诊断')).not.toBeInTheDocument()
    expect(screen.queryByText(/manifest|dylib|runtime missing|文件缺失/i)).not.toBeInTheDocument()
  })

  it('shows a runtime startup failure instead of an endless checking message', () => {
    const failedRuntimeStatus: PersonalWechatSenderStatus = {
      ...unavailableStatus,
      state: 'error',
      endpointReady: false,
      runtimeReady: false,
      message: '发送运行时启动失败（进程退出码 1）',
      error: '发送运行时启动失败（进程退出码 1）'
    }

    render(
      <PersonalWechatSetupGuide
        senderStatus={failedRuntimeStatus}
        binding={false}
        detecting={false}
        sessionBound={false}
        showBindAction={false}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('发送运行时启动失败（进程退出码 1）')
    expect(screen.queryByText('正在检查 发送运行时…')).not.toBeInTheDocument()
  })

  it('describes a ready runtime separately from pending send capability initialization', () => {
    const boundStatus: PersonalWechatSenderStatus = {
      ...unavailableStatus,
      state: 'hook_not_ready',
      wechatRunning: true,
      wechatPid: 4668,
      boundWechatPid: 4668,
      endpointReady: true,
      runtimeReady: true,
      attachReady: true,
      baseAddressReady: true,
      message: '已绑定，等待发送 hook 就绪'
    }

    render(
      <PersonalWechatSetupGuide
        senderStatus={boundStatus}
        binding={false}
        detecting={false}
        sessionBound
        showBindAction={false}
      />
    )

    expect(screen.getByText('微信已绑定，正在等待发送能力完成初始化…')).toBeVisible()
    expect(screen.queryByText('正在等待发送运行时完成初始化…')).not.toBeInTheDocument()
  })

  it('does not say the runtime is still initializing when it is ready but message capabilities are pending', () => {
    const boundButInitializing: PersonalWechatSenderStatus = {
      ...unavailableStatus,
      state: 'hook_not_ready',
      wechatRunning: true,
      wechatPid: 4668,
      boundWechatPid: 4668,
      endpointReady: true,
      runtimeReady: true,
      attachReady: true,
      baseAddressReady: true,
      message: '已绑定，等待发送 hook 就绪'
    }

    render(
      <PersonalWechatSetupGuide
        senderStatus={boundButInitializing}
        binding={false}
        detecting={false}
        sessionBound
        showBindAction={false}
        showBindingInstructionsInInitialization
      />
    )

    expect(screen.getByText('微信已绑定，正在等待发送能力完成初始化…')).toBeVisible()
    expect(screen.queryByText('正在等待发送运行时完成初始化…')).not.toBeInTheDocument()
  })

  it('shows the disabled binding flow on the settings page', async () => {
    render(<PersonalWechatSendPage onNotice={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: '先准备好微信消息功能' })).toBeVisible()
    expect(screen.getByRole('button', { name: '绑定微信' })).toBeDisabled()
    expect(screen.queryByText(/发送能力属授权制|联系群主/)).toBeNull()
    expect(screen.getByText(/发送运行时未就绪/)).toBeVisible()
    expect(screen.queryByRole('link', { name: '这里' })).toBeNull()
    expect(screen.queryByText(/manifest|dylib|runtime missing|文件缺失/i)).not.toBeInTheDocument()
  })
})

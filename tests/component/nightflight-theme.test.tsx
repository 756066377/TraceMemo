import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { GlassCard, GlassPanel } from '../../src/renderer/src/components/ui/glass-panel'
import { ResponsivePanel } from '../../src/renderer/src/components/ui/responsive-panel'
import { useAppearanceTheme } from '../../src/renderer/src/hooks/useAppearanceTheme'

function mediaQuery(initial: boolean): {
  change: (matches: boolean) => void
  remove: ReturnType<typeof vi.fn>
} {
  let listener: (() => void) | undefined
  const remove = vi.fn()
  const media = {
    matches: initial,
    addEventListener: vi.fn((_event: string, callback: () => void) => {
      listener = callback
    }),
    removeEventListener: remove
  }
  vi.spyOn(window, 'matchMedia').mockReturnValue(media as unknown as MediaQueryList)
  return {
    change: (matches) =>
      act(() => {
        media.matches = matches
        listener?.()
      }),
    remove
  }
}

function Theme({ preference }: { preference: 'system' | 'dark' | 'light' }): React.ReactElement {
  useAppearanceTheme(preference)
  return <div>主题内容</div>
}

describe('Nightflight theme and responsive surfaces', () => {
  it('resolves system appearance and follows changes, then unsubscribes', () => {
    const media = mediaQuery(false)
    const view = render(<Theme preference="system" />)
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.appearance).toBe('system')
    media.change(true)
    expect(document.documentElement.dataset.theme).toBe('dark')
    view.unmount()
    expect(media.remove).toHaveBeenCalled()
  })

  it('keeps an explicit light preference when the system becomes dark', () => {
    const media = mediaQuery(false)
    const view = render(<Theme preference="light" />)
    media.change(true)
    expect(document.documentElement.dataset.theme).toBe('light')
    view.rerender(<Theme preference="dark" />)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('forwards surface attributes and renders card content and real actions', async () => {
    const onClick = vi.fn()
    const ref = { current: null as HTMLDivElement | null }
    render(
      <GlassPanel ref={ref} tone="emphasis" aria-label="连接面板">
        <GlassCard
          title="连接状态"
          description="数据库已连接"
          actions={<button onClick={onClick}>刷新</button>}
        >
          <p>本地数据</p>
        </GlassCard>
      </GlassPanel>
    )
    expect(ref.current).toBe(screen.getByLabelText('连接面板'))
    expect(screen.getByRole('heading', { name: '连接状态' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('opens the compact panel, supports Escape and restores trigger focus', async () => {
    mediaQuery(true)
    const user = userEvent.setup()
    render(
      <ResponsivePanel title="证据与来源">
        <button>定位原文</button>
      </ResponsivePanel>
    )
    const trigger = screen.getByRole('button', { name: '证据与来源' })
    expect(screen.queryByRole('button', { name: '定位原文' })).not.toBeInTheDocument()
    await user.click(trigger)
    expect(screen.getByRole('dialog', { name: '证据与来源' })).toBeVisible()
    expect(screen.getByRole('button', { name: '定位原文' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
  })

  it('shows one inline panel at wide widths and adapts to a resize', async () => {
    const media = mediaQuery(false)
    render(
      <ResponsivePanel title="导出预览">
        <p>导出任务</p>
      </ResponsivePanel>
    )
    expect(screen.getAllByText('导出任务')).toHaveLength(1)
    media.change(true)
    await userEvent.click(screen.getByRole('button', { name: '导出预览' }))
    expect(screen.getAllByText('导出任务')).toHaveLength(1)
    media.change(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getAllByText('导出任务')).toHaveLength(1)
  })

  it('reveals compact evidence when a citation requests it without opening on initial render', () => {
    mediaQuery(true)
    const view = render(
      <ResponsivePanel title="证据" revealKey={0}>
        <p>引用消息</p>
      </ResponsivePanel>
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    view.rerender(
      <ResponsivePanel title="证据" revealKey={1}>
        <p>引用消息</p>
      </ResponsivePanel>
    )
    expect(screen.getByRole('dialog', { name: '证据' })).toBeVisible()
  })
})

import React from 'react'
import { AccountSummary } from '../account/AccountSummary'
import { PrimaryNavigation } from './PrimaryNavigation'
import { AppPage, PRIMARY_NAV_ITEMS } from './navigation'
import { GlassPanel } from '../ui/glass-panel'

interface SelfInfo {
  wxid: string
  nickname: string
  avatar?: string
  accountRoot: string
}

interface AppShellProps {
  activePage: AppPage
  selfInfo: SelfInfo | null
  dbReady: boolean
  dbConnecting?: boolean
  onPageChange: (page: AppPage) => void
  onOpenSettings: () => void
  onOpenGuide: () => void
  appearanceTheme?: 'system' | 'light' | 'dark'
  compactMode?: boolean
  children: React.ReactNode
}

export function AppShell({
  activePage,
  selfInfo,
  dbReady,
  dbConnecting = false,
  onPageChange,
  onOpenSettings,
  onOpenGuide,
  appearanceTheme = 'system',
  compactMode = false,
  children
}: AppShellProps): React.ReactElement {
  const activeItem = PRIMARY_NAV_ITEMS.find((item) => item.id === activePage)

  return (
    <div className={`app-shell theme-${appearanceTheme} ${compactMode ? 'is-compact' : ''}`}>
      <a className="tm-skip-link" href="#workspace-content">
        跳到工作区
      </a>
      <aside className="app-primary-rail tm-glass-panel tm-glass-emphasis">
        <PrimaryNavigation activePage={activePage} onPageChange={onPageChange} />
        <button
          type="button"
          className="dui-btn dui-btn-ghost app-guide-launcher"
          onClick={onOpenGuide}
          title="重新打开新手引导"
        >
          <span className="app-guide-launcher-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M12 3 14.2 9.8 21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3Z" />
            </svg>
          </span>
          <span className="app-guide-launcher-label">新手引导</span>
        </button>
        <div className="app-rail-account">
          <AccountSummary
            selfInfo={selfInfo}
            dbReady={dbReady}
            dbConnecting={dbConnecting}
            compact
            onClick={onOpenSettings}
          />
        </div>
      </aside>
      <main
        id="workspace-content"
        tabIndex={-1}
        className="app-shell-main"
        aria-label={activeItem?.label || '工作区'}
      >
        <GlassPanel className="tm-workspace-surface">{children}</GlassPanel>
      </main>
    </div>
  )
}

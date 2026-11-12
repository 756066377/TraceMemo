import { useLayoutEffect } from 'react'

export type AppearancePreference = 'system' | 'light' | 'dark'

/** Apply the resolved theme above every workspace and Radix portal, including sign-in. */
export function useAppearanceTheme(preference: AppearancePreference): void {
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      document.documentElement.dataset.appearance = preference
      document.documentElement.dataset.theme =
        preference === 'system' ? (media.matches ? 'dark' : 'light') : preference
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [preference])
}

import * as React from 'react'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './dialog'
import { Button } from './button'
import { cn } from '../../lib/cn'

/** Mount exactly one copy so forms, progress subscriptions and focus IDs stay unique. */
export function ResponsivePanel({
  title,
  children,
  className,
  revealKey
}: {
  title: string
  children: React.ReactNode
  className?: string
  revealKey?: string | number
}): React.ReactElement {
  const [compact, setCompact] = React.useState(
    () => window.matchMedia('(max-width: 1279px)').matches
  )
  const [open, setOpen] = React.useState(false)
  const previousReveal = React.useRef(revealKey)
  React.useEffect(() => {
    if (compact && revealKey !== previousReveal.current) setOpen(true)
    previousReveal.current = revealKey
  }, [compact, revealKey])
  React.useEffect(() => {
    const media = window.matchMedia('(max-width: 1279px)')
    const update = (): void => {
      setCompact(media.matches)
      if (!media.matches) setOpen(false)
    }
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  if (!compact) return <div className={cn('tm-responsive-panel', className)}>{children}</div>
  return (
    <div className="tm-panel-launcher">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            {title}
          </Button>
        </DialogTrigger>
        <DialogContent className="tm-panel-dialog" aria-describedby={undefined}>
          <DialogTitle>{title}</DialogTitle>
          <div className={cn('tm-responsive-panel', className)}>{children}</div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

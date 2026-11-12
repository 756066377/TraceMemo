import * as React from 'react'
import { cn } from '../../lib/cn'

export interface GlassPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: 'default' | 'emphasis' | 'floating'
}

export const GlassPanel = React.forwardRef<HTMLDivElement, GlassPanelProps>(
  ({ tone = 'default', className, ...props }, ref) => (
    <div ref={ref} className={cn('tm-glass-panel', `tm-glass-${tone}`, className)} {...props} />
  )
)
GlassPanel.displayName = 'GlassPanel'

export interface GlassCardProps extends Omit<GlassPanelProps, 'title'> {
  title?: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
}

export const GlassCard = React.forwardRef<HTMLDivElement, GlassCardProps>(
  ({ title, description, actions, children, className, ...props }, ref) => {
    const titleId = React.useId()
    return (
      <GlassPanel
        ref={ref}
        role="group"
        className={cn('dui-card', className)}
        aria-labelledby={title ? titleId : undefined}
        {...props}
      >
        <div className="dui-card-body">
          {title && (
            <h2 id={titleId} className="dui-card-title">
              {title}
            </h2>
          )}
          {description && <p className="text-muted-foreground">{description}</p>}
          {children}
          {actions && <div className="dui-card-actions justify-end">{actions}</div>}
        </div>
      </GlassPanel>
    )
  }
)
GlassCard.displayName = 'GlassCard'

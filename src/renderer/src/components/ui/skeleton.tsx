import { cn } from '../../lib/cn'

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return <div className={cn('dui-skeleton animate-pulse rounded-md bg-muted', className)} {...props} />
}

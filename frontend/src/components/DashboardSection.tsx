import { useEffect, useState, type ReactNode } from 'react'

interface DashboardSectionProps {
  title: string
  meta?: ReactNode
  defaultExpanded?: boolean
  className?: string
  bodyClassName?: string
  onExpandedChange?: (expanded: boolean) => void
  children: ReactNode
}

export default function DashboardSection({
  title,
  meta,
  defaultExpanded = true,
  className = '',
  bodyClassName = '',
  onExpandedChange,
  children,
}: DashboardSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  useEffect(() => {
    onExpandedChange?.(expanded)
  }, [expanded, onExpandedChange])

  return (
    <div
      className={`card dashboard-section ${
        expanded ? 'dashboard-section-expanded' : 'dashboard-section-collapsed'
      } ${className}`.trim()}
    >
      <button
        type="button"
        className="dashboard-section-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="dashboard-section-title">
          {expanded ? '▼' : '▶'} {title}
        </span>
        {meta ? <span className="dashboard-section-meta">{meta}</span> : null}
      </button>
      {expanded ? (
        <div className={`dashboard-section-body ${bodyClassName}`.trim()}>{children}</div>
      ) : null}
    </div>
  )
}

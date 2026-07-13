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

function notifyChartsResize() {
  window.dispatchEvent(new Event('resize'))
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

  useEffect(() => {
    if (!expanded) return
    const id = window.requestAnimationFrame(() => {
      notifyChartsResize()
    })
    return () => window.cancelAnimationFrame(id)
  }, [expanded])

  function toggleExpanded() {
    setExpanded((value) => {
      const next = !value
      if (next) {
        window.requestAnimationFrame(() => notifyChartsResize())
      }
      return next
    })
  }

  return (
    <div
      className={`card dashboard-section ${
        expanded ? 'dashboard-section-expanded' : 'dashboard-section-collapsed'
      } ${className}`.trim()}
    >
      <button
        type="button"
        className="dashboard-section-header"
        onClick={toggleExpanded}
        aria-expanded={expanded}
      >
        <span className="dashboard-section-title">
          {expanded ? '▼' : '▶'} {title}
        </span>
        {meta ? <span className="dashboard-section-meta">{meta}</span> : null}
      </button>
      <div
        className={`dashboard-section-body ${bodyClassName} ${
          expanded ? '' : 'dashboard-section-body-hidden'
        }`.trim()}
        aria-hidden={!expanded}
      >
        {children}
      </div>
    </div>
  )
}

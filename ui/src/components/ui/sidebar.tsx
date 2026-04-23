/**
 * Lightweight Nook Sidebar primitive — fixed vertical strip with stacked
 * sections. Doesn't try to be the full shadcn Sidebar (no Sheet, no
 * keyboard shortcut, no cookie persistence) — those features matter for
 * generic apps, not for our Electron desktop layout.
 *
 * Supports collapse-to-icons via SidebarProvider context. State persists
 * in localStorage so the user's preference survives reloads.
 *
 * Usage:
 *   <SidebarProvider>
 *     <Sidebar>
 *       <SidebarHeader>...wordmark + status dot...</SidebarHeader>
 *       <SidebarSection>
 *         <SidebarMenuItem to="/drive" icon={HardDrive} label="Drive" />
 *       </SidebarSection>
 *       <SidebarSpacer />
 *       <SidebarFooter>
 *         <SidebarMenuItem to="/settings" icon={Settings} label="Settings" />
 *         <SidebarTrigger />
 *       </SidebarFooter>
 *     </Sidebar>
 *     <main>...</main>
 *   </SidebarProvider>
 */
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import * as React from 'react'
import { NavLink } from 'react-router-dom'

import { cn } from '../../lib/utils'

const STORAGE_KEY = 'nook:sidebar-expanded'

interface SidebarContextValue {
  expanded: boolean
  toggle: () => void
  setExpanded: (expanded: boolean) => void
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

export function useSidebar(): SidebarContextValue {
  const ctx = React.useContext(SidebarContext)

  if (!ctx) throw new Error('useSidebar must be used inside <SidebarProvider>')

  return ctx
}

interface SidebarProviderProps {
  children: React.ReactNode
  /** Default expanded state if no localStorage value exists. */
  defaultExpanded?: boolean
}

export function SidebarProvider({ children, defaultExpanded = false }: SidebarProviderProps) {
  const [expanded, setExpandedState] = React.useState<boolean>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)

    return stored === 'true' ? true : stored === 'false' ? false : defaultExpanded
  })

  const setExpanded = React.useCallback((next: boolean) => {
    localStorage.setItem(STORAGE_KEY, String(next))
    setExpandedState(next)
  }, [])

  const toggle = React.useCallback(() => setExpanded(!expanded), [expanded, setExpanded])

  return <SidebarContext.Provider value={{ expanded, toggle, setExpanded }}>{children}</SidebarContext.Provider>
}

const Sidebar = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, children, ...props }, ref) => {
    const { expanded } = useSidebar()

    return (
      <aside
        ref={ref}
        className={cn(
          'flex flex-col items-stretch pt-5 pb-4 shrink-0 border-r border-sidebar-border/10 gap-1 bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-in-out',
          expanded ? 'w-56' : 'w-20',
          className,
        )}
        {...props}
      >
        {children}
      </aside>
    )
  },
)

Sidebar.displayName = 'Sidebar'

const SidebarHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col items-center', className)} {...props} />
  ),
)

SidebarHeader.displayName = 'SidebarHeader'

const SidebarSection = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <nav ref={ref} className={cn('flex flex-col gap-0.5 w-full px-2', className)} {...props} />
  ),
)

SidebarSection.displayName = 'SidebarSection'

const SidebarSectionLabel = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, children, ...props }, ref) => {
    const { expanded } = useSidebar()

    return (
      <span
        ref={ref}
        className={cn(
          'text-[10px] font-bold uppercase tracking-widest mb-1.5 w-full text-sidebar-muted px-3',
          expanded ? 'text-left' : 'text-center',
          className,
        )}
        {...props}
      >
        {expanded ? children : '·'}
      </span>
    )
  },
)

SidebarSectionLabel.displayName = 'SidebarSectionLabel'

const SidebarSeparator = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('mx-3 my-3 border-t border-sidebar-border/25', className)} {...props} />
  ),
)

SidebarSeparator.displayName = 'SidebarSeparator'

const SidebarFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('w-full', className)} {...props} />,
)

SidebarFooter.displayName = 'SidebarFooter'

/** Pushes anything below it to the bottom of the sidebar. */
const SidebarSpacer = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('flex-1', className)} {...props} />,
)

SidebarSpacer.displayName = 'SidebarSpacer'

interface SidebarMenuItemProps {
  to: string
  icon: LucideIcon
  label: string
  /** Numeric badge shown over the icon (eg unread count) */
  badge?: number
  onClick?: () => void
  className?: string
}

const SidebarMenuItem = React.forwardRef<HTMLAnchorElement, SidebarMenuItemProps>(
  ({ to, icon: Icon, label, badge, onClick, className }, ref) => {
    const { expanded } = useSidebar()

    return (
      <NavLink
        ref={ref}
        to={to}
        onClick={onClick}
        title={!expanded ? label : undefined}
        className={({ isActive }) =>
          cn(
            'flex items-center gap-3 h-10 rounded-lg transition-colors relative text-sm font-medium',
            expanded ? 'px-3 mx-1' : 'h-12 w-12 mx-auto justify-center',
            isActive ? 'bg-sidebar-accent text-sidebar-foreground' : 'text-sidebar-muted hover:text-sidebar-foreground',
            className,
          )
        }
      >
        <span className="relative shrink-0 flex items-center justify-center">
          <Icon size={20} />
          {badge !== undefined && badge > 0 && (
            <span className="absolute -top-1 -right-2 text-[8px] font-bold leading-none px-1 py-0.5 rounded-full min-w-[14px] text-center bg-primary text-primary-foreground">
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </span>
        {expanded && <span className="truncate">{label}</span>}
      </NavLink>
    )
  },
)

SidebarMenuItem.displayName = 'SidebarMenuItem'

/**
 * Toggle button for collapsing/expanding the sidebar. Place it in the footer
 * (or anywhere) — uses the SidebarProvider context.
 */
const SidebarTrigger = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, ...props }, ref) => {
    const { expanded, toggle } = useSidebar()

    return (
      <button
        ref={ref}
        onClick={toggle}
        title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        className={cn(
          'flex items-center justify-center h-10 w-10 mx-auto rounded-lg transition-colors text-sidebar-muted hover:text-sidebar-foreground hover:bg-sidebar-accent',
          className,
        )}
        {...props}
      >
        {expanded ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>
    )
  },
)

SidebarTrigger.displayName = 'SidebarTrigger'

export {
  Sidebar,
  SidebarHeader,
  SidebarSection,
  SidebarSectionLabel,
  SidebarSeparator,
  SidebarFooter,
  SidebarSpacer,
  SidebarMenuItem,
  SidebarTrigger,
}

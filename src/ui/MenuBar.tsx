import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action?: () => void;
  separator?: boolean;
}

export interface Menu {
  label: string;
  items: MenuItem[];
}

export function MenuBar({ menus, right }: { menus: Menu[]; right?: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="menubar" ref={barRef}>
      {menus.map((menu) => (
        <div key={menu.label} className="menu">
          <button
            type="button"
            className={`menu-title${open === menu.label ? ' open' : ''}`}
            onClick={() => setOpen(open === menu.label ? null : menu.label)}
            // Once a menu is open, sliding across the bar switches menus, the
            // way a native menu bar behaves.
            onMouseEnter={() => open !== null && setOpen(menu.label)}
          >
            {menu.label}
          </button>

          {open === menu.label && (
            <div className="menu-dropdown">
              {menu.items.map((item, index) =>
                item.separator ? (
                  <div key={`sep-${index}`} className="menu-separator" />
                ) : (
                  <button
                    key={item.label}
                    type="button"
                    className="menu-item"
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(null);
                      item.action?.();
                    }}
                  >
                    <span>{item.label}</span>
                    {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
      {right && <div className="menubar-right">{right}</div>}
    </div>
  );
}

export interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * Right-click menu.
 *
 * Browsers fire `contextmenu` like any other event, so intercepting it and
 * drawing our own menu works exactly as it does in a desktop app.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Flip the menu back inside the window if it would open off the edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition({
      x: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="menu-dropdown context-menu"
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={`sep-${index}`} className="menu-separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            className="menu-item"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.action?.();
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}

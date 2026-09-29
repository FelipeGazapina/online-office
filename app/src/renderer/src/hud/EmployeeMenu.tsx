import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Employee } from '../../../shared/protocol.ts';
import { walkTo } from '../sim.ts';
import { get, set, useStore } from '../store.ts';

const MARGIN = 8;

export function EmployeeMenu() {
  const menu = useStore((s) => s.menu);
  const employee = useStore((s) => s.company?.employees.find((x) => x.id === s.menu?.employeeId));
  const gone = menu !== null && !employee;

  useEffect(() => {
    if (gone) set({ menu: null });
  }, [gone]);

  if (!menu || !employee) return null;
  return <Menu employee={employee} x={menu.x} y={menu.y} />;
}

function Menu({ employee, x, y }: { employee: Employee; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // offsetWidth ignores the scale of the pop animation, which getBoundingClientRect would include.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - el.offsetWidth - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - el.offsetHeight - MARGIN)),
    });
  }, [x, y]);

  useEffect(() => {
    const closeOnOutsideClick = (ev: MouseEvent) => {
      if (ev.target instanceof Node && ref.current?.contains(ev.target)) return;
      ev.stopPropagation();
      ev.preventDefault();
      set({ menu: null });
    };
    window.addEventListener('click', closeOnOutsideClick, true);
    return () => window.removeEventListener('click', closeOnOutsideClick, true);
  }, []);

  return (
    <div ref={ref} className="emp-menu" style={pos}>
      <button
        onClick={() => {
          if (get().selectedId === employee.id) document.getElementById('drawer-input')?.focus();
          set({ selectedId: employee.id, menu: null });
        }}
      >
        Open chat
      </button>
      <button
        onClick={() => {
          walkTo({ kind: 'employee', employeeId: employee.id });
          set({ menu: null });
        }}
      >
        Go to {employee.name}
      </button>
    </div>
  );
}

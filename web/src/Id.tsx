import type { ReactNode } from 'react';

/** Sequencing (13 Nov 2026): the ID after the name, smaller and muted (search by ID still works). */
export function Id({ children }: { children: ReactNode }) {
  return <span className="id-muted">{children}</span>;
}

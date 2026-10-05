'use client';

import Sidebar from './Sidebar';
import Header from './Header';

export default function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-graphite-950">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main className="min-h-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

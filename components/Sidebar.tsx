'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useDevices, type Device } from './DeviceContext';
import AddDeviceModal from './AddDeviceModal';
import { Plus, Server, LogOut, Trash2, Pencil, LayoutGrid } from 'lucide-react';

export default function Sidebar() {
  const { devices, removeDevice } = useDevices();
  const params = useParams<{ id?: string }>();
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };

  const openEdit = (d: Device) => {
    setEditing(d);
    setModalOpen(true);
  };

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-graphite-700 bg-graphite-900">
      <div className="flex items-center gap-2 border-b border-graphite-700 px-4 py-3.5">
        <div className="h-1.5 w-1.5 rounded-full bg-signal" />
        <span className="text-sm font-semibold text-neutral-100">Network Dashboard</span>
      </div>

      <Link
        href="/"
        className={`mx-2 mt-2 flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
          !params?.id ? 'bg-graphite-800 text-neutral-100' : 'text-neutral-400 hover:bg-graphite-800/60'
        }`}
      >
        <LayoutGrid size={14} />
        Overview
      </Link>

      <div className="mt-4 flex items-center justify-between px-4">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Devices
        </span>
        <button
          onClick={openAdd}
          className="rounded p-1 text-neutral-400 hover:bg-graphite-800 hover:text-neutral-100"
          title="Add device"
        >
          <Plus size={15} />
        </button>
      </div>

      <nav className="mt-1 flex-1 space-y-0.5 overflow-y-auto px-2 py-1">
        {devices.map((d) => {
          const active = params?.id === d.id;
          return (
            <div key={d.id} className="group flex items-center">
              <Link
                href={`/device/${d.id}`}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-sm ${
                  active ? 'bg-graphite-800 text-neutral-100' : 'text-neutral-300 hover:bg-graphite-800/60'
                }`}
              >
                <Server size={14} style={{ color: d.color, flexShrink: 0 }} />
                <span className="truncate">{d.name}</span>
              </Link>
              <button
                onClick={() => openEdit(d)}
                className="hidden shrink-0 p-1.5 text-neutral-500 hover:text-neutral-100 group-hover:block"
                title="Edit device"
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={() => {
                  if (confirm(`Remove ${d.name}?`)) removeDevice(d.id);
                }}
                className="hidden shrink-0 p-1.5 text-neutral-500 hover:text-red-400 group-hover:block"
                title="Remove device"
              >
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}

        {devices.length === 0 && (
          <p className="px-2 py-4 text-xs leading-relaxed text-neutral-500">
            No devices yet. Add your router, NAS, or any other admin UI to get started.
          </p>
        )}
      </nav>

      <button
        onClick={logout}
        className="flex items-center gap-2 border-t border-graphite-700 px-4 py-3 text-sm text-neutral-400 hover:text-neutral-100"
      >
        <LogOut size={14} />
        Log out
      </button>

      {modalOpen && <AddDeviceModal initial={editing} onClose={() => setModalOpen(false)} />}
    </aside>
  );
}

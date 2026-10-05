'use client';

import { useState } from 'react';
import { useDevices } from '@/components/DeviceContext';
import AddDeviceModal from '@/components/AddDeviceModal';
import { Plus } from 'lucide-react';

export default function DashboardHome() {
  const { devices, loading } = useDevices();
  const [modalOpen, setModalOpen] = useState(false);

  if (loading) return null;

  if (devices.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-neutral-500">
          No devices registered yet. Add your router, NAS, or access point to bring
          its web UI into this dashboard.
        </p>
        <button
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-1.5 rounded bg-signal px-3 py-1.5 text-sm font-medium text-graphite-950 hover:bg-signal/90"
        >
          <Plus size={14} />
          Add your first device
        </button>
        {modalOpen && <AddDeviceModal onClose={() => setModalOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center text-sm text-neutral-500">
      Select a device from the sidebar to open its web UI here.
    </div>
  );
}

'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export type Device = {
  id: string;
  name: string;
  ip: string;
  port: number;
  protocol: string;
  base_path: string;
  icon: string;
  color: string;
  created_at: number;
};

export type DeviceInput = {
  name: string;
  ip: string;
  port: number;
  protocol: string;
  basePath: string;
  color: string;
};

type Ctx = {
  devices: Device[];
  loading: boolean;
  refresh: () => Promise<void>;
  addDevice: (d: DeviceInput) => Promise<void>;
  updateDevice: (id: string, d: DeviceInput) => Promise<void>;
  removeDevice: (id: string) => Promise<void>;
};

const DeviceContext = createContext<Ctx | null>(null);

export function DeviceProvider({ children }: { children: React.ReactNode }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/devices');
    if (res.ok) setDevices(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addDevice = async (d: DeviceInput) => {
    await fetch('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(d),
    });
    await refresh();
  };

  const updateDevice = async (id: string, d: DeviceInput) => {
    await fetch(`/api/devices/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(d),
    });
    await refresh();
  };

  const removeDevice = async (id: string) => {
    await fetch(`/api/devices/${id}`, { method: 'DELETE' });
    await refresh();
  };

  return (
    <DeviceContext.Provider value={{ devices, loading, refresh, addDevice, updateDevice, removeDevice }}>
      {children}
    </DeviceContext.Provider>
  );
}

export function useDevices() {
  const ctx = useContext(DeviceContext);
  if (!ctx) throw new Error('useDevices must be used within a DeviceProvider');
  return ctx;
}

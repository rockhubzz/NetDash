'use client';

import { useParams } from 'next/navigation';
import { useDevices } from './DeviceContext';

export default function Header() {
  const params = useParams<{ id?: string }>();
  const { devices } = useDevices();
  const device = devices.find((d) => d.id === params?.id);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-graphite-700 px-4">
      {device ? (
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: device.color }}
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-neutral-100">{device.name}</div>
            <div className="truncate font-mono text-xs text-neutral-500">
              {device.protocol}://{device.ip}:{device.port}
              {device.base_path}
            </div>
          </div>
        </div>
      ) : (
        <span className="text-sm text-neutral-500">No device selected</span>
      )}
    </header>
  );
}

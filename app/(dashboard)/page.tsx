'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useDevices, type Device } from '@/components/DeviceContext';
import AddDeviceModal from '@/components/AddDeviceModal';
import { Plus, Server, Eye } from 'lucide-react';

type SessionInfo = {
  viewers: number;
  streaming: boolean;
  width: number;
  height: number;
  startedAt: number;
};

function timeAgo(ts: number) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function DeviceCard({ device, children }: { device: Device; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-graphite-700 bg-graphite-900 p-4">
      <div className="flex min-w-0 items-center gap-2">
        <Server size={16} style={{ color: device.color, flexShrink: 0 }} />
        <span className="truncate text-sm font-medium text-neutral-100">{device.name}</span>
      </div>
      <div className="mt-2 space-y-1 text-xs text-neutral-500">{children}</div>
      <Link
        href={`/device/${device.id}`}
        className="mt-3 inline-block rounded bg-signal/15 px-3 py-1 text-xs font-medium text-signal hover:bg-signal/25"
      >
        Open
      </Link>
    </div>
  );
}

export default function DashboardHome() {
  const { devices, loading } = useDevices();
  const [modalOpen, setModalOpen] = useState(false);
  const [sessions, setSessions] = useState<Record<string, SessionInfo>>({});

  // Live headless sessions, polled so the cards track reality.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/devices/status');
        if (res.ok && !cancelled) {
          const data = await res.json();
          setSessions(data.sessions ?? {});
        }
      } catch {
        // Transiently unreachable - keep the last known state.
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const activeDevices = useMemo(
    () => devices.filter((d) => sessions[d.id]),
    [devices, sessions]
  );
  const recentDevices = useMemo(
    () => [...devices].sort((a, b) => b.created_at - a.created_at).slice(0, 5),
    [devices]
  );

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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-8 p-6">
        <section>
          <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Active sessions
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            Devices whose browser is running on the server right now.
          </p>
          {activeDevices.length === 0 ? (
            <p className="mt-3 rounded-lg border border-dashed border-graphite-700 px-4 py-6 text-center text-sm text-neutral-500">
              Nothing running. Open a device to start its browser session.
            </p>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {activeDevices.map((d) => {
                const s = sessions[d.id];
                const live = s.viewers > 0;
                return (
                  <DeviceCard key={d.id} device={d}>
                    <p className="flex items-center gap-1.5">
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${live ? 'bg-green-400' : 'bg-neutral-500'}`}
                      />
                      <span className={live ? 'text-green-300' : 'text-neutral-400'}>
                        {live
                          ? `Live - ${s.viewers} watching`
                          : 'Idle - browser kept warm'}
                      </span>
                    </p>
                    <p>
                      {s.width}×{s.height}
                    </p>
                  </DeviceCard>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Recently added
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recentDevices.map((d) => (
              <DeviceCard key={d.id} device={d}>
                <p>
                  {d.protocol}://{d.ip}:{d.port}
                  {d.base_path}
                </p>
                <p className="flex items-center gap-1.5">
                  {sessions[d.id]?.viewers ? (
                    <>
                      <Eye size={12} className="text-green-400" />
                      <span className="text-green-300">Active now</span>
                    </>
                  ) : (
                    <span>Added {timeAgo(d.created_at)}</span>
                  )}
                </p>
              </DeviceCard>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { useDevices, type Device } from './DeviceContext';

const COLORS = ['#e8a33d', '#4f9d69', '#5b8def', '#c964d8', '#e05c5c', '#3fb5c9'];

export default function AddDeviceModal({
  initial,
  onClose,
}: {
  initial?: Device | null;
  onClose: () => void;
}) {
  const { addDevice, updateDevice } = useDevices();
  const [form, setForm] = useState({
    name: initial?.name || '',
    ip: initial?.ip || '',
    port: initial?.port ?? 80,
    protocol: initial?.protocol || 'http',
    basePath: initial?.base_path || '',
    color: initial?.color || COLORS[0],
  });
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    if (initial) {
      await updateDevice(initial.id, form);
    } else {
      await addDevice(form);
    }
    setSaving(false);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-80 space-y-3 rounded-lg border border-graphite-600 bg-graphite-900 p-4"
      >
        <h2 className="text-sm font-semibold text-neutral-100">
          {initial ? 'Edit device' : 'Add device'}
        </h2>

        <div>
          <label className="mb-1 block text-xs text-neutral-500">Name</label>
          <input
            required
            placeholder="e.g. NAS, Core Router"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full rounded border border-graphite-600 bg-graphite-800 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-signal"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-neutral-500">IP address</label>
          <input
            required
            placeholder="192.168.1.20"
            value={form.ip}
            onChange={(e) => setForm({ ...form, ip: e.target.value })}
            className="w-full rounded border border-graphite-600 bg-graphite-800 px-2 py-1.5 text-sm font-mono text-neutral-100 outline-none focus:border-signal"
          />
        </div>

        <div className="flex gap-2">
          <div className="w-24">
            <label className="mb-1 block text-xs text-neutral-500">Protocol</label>
            <select
              value={form.protocol}
              onChange={(e) => setForm({ ...form, protocol: e.target.value })}
              className="w-full rounded border border-graphite-600 bg-graphite-800 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-signal"
            >
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-xs text-neutral-500">Port</label>
            <input
              required
              type="number"
              value={form.port}
              onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
              className="w-full rounded border border-graphite-600 bg-graphite-800 px-2 py-1.5 text-sm font-mono text-neutral-100 outline-none focus:border-signal"
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs text-neutral-500">Base path (optional)</label>
          <input
            placeholder="/admin"
            value={form.basePath}
            onChange={(e) => setForm({ ...form, basePath: e.target.value })}
            className="w-full rounded border border-graphite-600 bg-graphite-800 px-2 py-1.5 text-sm font-mono text-neutral-100 outline-none focus:border-signal"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-neutral-500">Color tag</label>
          <div className="flex gap-1.5">
            {COLORS.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => setForm({ ...form, color: c })}
                className="h-6 w-6 rounded-full"
                style={{
                  backgroundColor: c,
                  outline: form.color === c ? '2px solid white' : 'none',
                  outlineOffset: '2px',
                }}
              />
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-signal px-3 py-1.5 text-sm font-medium text-graphite-950 hover:bg-signal/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save device'}
          </button>
        </div>
      </form>
    </div>
  );
}

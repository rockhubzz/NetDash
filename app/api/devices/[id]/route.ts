import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import browserManager from '@/lib/browser-manager';

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json();
  const { name, ip, port, protocol, basePath, icon, color } = body;

  const existing = db.prepare('SELECT * FROM devices WHERE id = ?').get(params.id) as any;
  if (!existing) {
    return NextResponse.json({ error: 'Device not found' }, { status: 404 });
  }

  db.prepare(
    `UPDATE devices SET name=?, ip=?, port=?, protocol=?, base_path=?, icon=?, color=? WHERE id=?`
  ).run(
    name ?? existing.name,
    ip ?? existing.ip,
    port ?? existing.port,
    protocol ?? existing.protocol,
    basePath ?? existing.base_path,
    icon ?? existing.icon,
    color ?? existing.color,
    params.id
  );

  // Connection details may have changed - drop the running browser session so
  // the next view opens a fresh one against the (possibly new) address.
  await browserManager.destroySession(params.id).catch(() => {});

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(params.id);
  return NextResponse.json(device);
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await browserManager.destroySession(params.id).catch(() => {});
  db.prepare('DELETE FROM devices WHERE id = ?').run(params.id);
  return NextResponse.json({ ok: true });
}

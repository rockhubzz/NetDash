import { NextRequest, NextResponse } from 'next/server';
import db from '@/lib/db';
import { randomUUID } from 'crypto';

export async function GET() {
  const devices = db.prepare('SELECT * FROM devices ORDER BY created_at ASC').all();
  return NextResponse.json(devices);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, ip, port, protocol, basePath, icon, color } = body;

  if (!name || !ip || !port) {
    return NextResponse.json({ error: 'name, ip, and port are required' }, { status: 400 });
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO devices (id, name, ip, port, protocol, base_path, icon, color, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    ip,
    port,
    protocol || 'http',
    basePath || '',
    icon || 'server',
    color || '#e8a33d',
    Date.now()
  );

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  return NextResponse.json(device, { status: 201 });
}

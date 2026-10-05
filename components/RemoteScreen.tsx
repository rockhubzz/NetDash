'use client';

import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

const FALLBACK_WIDTH = 1280;
const FALLBACK_HEIGHT = 800;

// How often a container resize is forwarded to the server (which then
// resizes the headless page - debounced to avoid reflow storms).
const RESIZE_DEBOUNCE_MS = 300;

// If the stream drops unexpectedly (server restart, blip, failed handshake),
// retry on a short backoff instead of sitting at "Connecting…" forever.
const MAX_ATTEMPTS = 10;
const RETRY_DELAY_MS = [1000, 1000, 2000, 2000, 3000, 5000, 5000, 5000, 5000, 5000];

export default function RemoteScreen({ deviceId }: { deviceId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // Live remote viewport, as reported by the server's metadata messages.
  // The canvas backing store always matches this; input coordinates are
  // scaled against it.
  const [remote, setRemote] = useState({ width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT });

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext('2d');

    canvas.width = FALLBACK_WIDTH;
    canvas.height = FALLBACK_HEIGHT;
    setRemote({ width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT });

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    // A server-sent {type:'error'} (unknown device, no browser, …) is
    // final - reconnecting won't help, so don't retry those.
    let serverRejected = false;

    setConnected(false);
    setError(null);
    setStatus('Connecting…');

    const send = (payload: Record<string, unknown>) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    const measure = () => {
      const rect = container.getBoundingClientRect();
      return {
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      };
    };

    const connect = () => {
      if (cancelled || serverRejected) return;
      attempts += 1;
      setStatus(attempts > 1 ? `Reconnecting… (attempt ${attempts})` : 'Connecting…');

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      // Report the component size up front so the first frames already
      // match it; further resizes go over the socket (see ResizeObserver).
      const initial = measure();
      const ws = new WebSocket(
        `${proto}://${window.location.host}/ws/device/${deviceId}?w=${initial.width}&h=${initial.height}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        // Container may have settled between effect start and open.
        const now = measure();
        if (now.width > 1 && now.height > 1) {
          ws.send(JSON.stringify({ type: 'viewport', width: now.width, height: now.height }));
        }
      };

      ws.onmessage = (event) => {
        let msg: { type: string; data?: string; message?: string; width?: number; height?: number };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === 'frame' && msg.data) {
          const img = new Image();
          img.onload = () => ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
          img.src = `data:image/jpeg;base64,${msg.data}`;
        } else if (msg.type === 'metadata' && msg.width && msg.height) {
          if (canvas.width !== msg.width || canvas.height !== msg.height) {
            canvas.width = msg.width;
            canvas.height = msg.height;
            setRemote({ width: msg.width, height: msg.height });
          }
        } else if (msg.type === 'error') {
          serverRejected = true;
          if (retryTimer) clearTimeout(retryTimer);
          setError(msg.message || 'Failed to open device');
          setConnected(false);
        }
      };

      // onerror alone carries no detail and is always followed by onclose -
      // all handling lives there so behaviour stays in one place.
      ws.onerror = () => {};

      ws.onclose = (e) => {
        if (wsRef.current === ws) wsRef.current = null;
        setConnected(false);
        if (cancelled || serverRejected) return;
        if (attempts >= MAX_ATTEMPTS) {
          setError(
            `Could not reach this device's browser (connection closed${e.code ? `, code ${e.code}` : ''}). The server may be starting up - try again shortly.`
          );
          return;
        }
        setStatus('Connection lost. Retrying…');
        retryTimer = setTimeout(
          connect,
          RETRY_DELAY_MS[Math.min(attempts - 1, RETRY_DELAY_MS.length - 1)]
        );
      };
    };

    const toRemoteCoords = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.round(((e.clientX - rect.left) / rect.width) * canvas.width),
        y: Math.round(((e.clientY - rect.top) / rect.height) * canvas.height),
      };
    };

    const buttonName = (b: number) => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');

    const onMouseMove = (e: MouseEvent) => send({ type: 'mousemove', ...toRemoteCoords(e) });
    const onMouseDown = (e: MouseEvent) => {
      canvas.focus();
      send({ type: 'mousedown', ...toRemoteCoords(e), button: buttonName(e.button) });
    };
    const onMouseUp = (e: MouseEvent) =>
      send({ type: 'mouseup', ...toRemoteCoords(e), button: buttonName(e.button) });
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      send({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      send({ type: 'keydown', key: e.key });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      send({ type: 'keyup', key: e.key });
    };
    const onContextMenu = (e: Event) => e.preventDefault();

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);

    // Forward component resizes so the headless page tracks this viewer.
    // Debounced: each resize reflows the remote page and restarts its
    // screencast.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSent = { width: 0, height: 0 };
    const observer = new ResizeObserver(() => {
      if (cancelled) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (cancelled) return;
        const size = measure();
        if (size.width <= 1 || size.height <= 1) return;
        if (size.width === lastSent.width && size.height === lastSent.height) return;
        lastSent = size;
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'viewport', width: size.width, height: size.height }));
        }
      }, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(container);

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [deviceId, retryNonce]);

  const reload = () => {
    wsRef.current?.send(JSON.stringify({ type: 'reload' }));
  };

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full items-center justify-center overflow-auto bg-black"
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        data-remote-screen
        style={{ aspectRatio: `${remote.width} / ${remote.height}` }}
        className="max-h-full max-w-full cursor-default outline-none"
      />

      <button
        onClick={reload}
        title="Reload"
        className="absolute right-3 top-3 rounded bg-graphite-900/80 p-2 text-neutral-300 hover:bg-graphite-800 hover:text-neutral-100"
      >
        <RefreshCw size={14} />
      </button>

      {!connected && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-graphite-950/90 text-sm text-neutral-400">
          {status}
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-graphite-950/90 px-6 text-center">
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={() => setRetryNonce((n) => n + 1)}
            className="rounded border border-graphite-600 px-3 py-1 text-xs text-neutral-300 hover:bg-graphite-800"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, Upload } from 'lucide-react';

const FALLBACK_WIDTH = 1280;
const FALLBACK_HEIGHT = 800;

// File-upload bridging: the headless browser runs on the server, so its
// native file picker can never see this machine's disk. Files picked here
// are sent over the device WebSocket (base64 chunks) and the server feeds
// them to the remote page's file chooser.
const UPLOAD_CHUNK_CHARS = 64 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // Live remote viewport, as reported by the server's metadata messages.
  // The canvas backing store always matches this; input coordinates are
  // scaled against it.
  const [remote, setRemote] = useState({ width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT });
  // A JavaScript dialog (alert/confirm/prompt/beforeunload) open in the
  // remote page. The stream can never show the browser's native popup, so
  // the server relays it and the viewer answers through this modal - the
  // remote page stays paused until then, exactly like a local browser.
  const [remoteDialog, setRemoteDialog] = useState<null | {
    dialogType: string;
    message: string;
    defaultValue: string;
  }>(null);
  const [promptText, setPromptText] = useState('');
  // File-upload bridging state. `fileWaiting` is set when the remote page
  // has a file picker open and is blocked waiting for bytes; `uploadNote`
  // is transient feedback (uploading / ready / delivered / error).
  const [fileWaiting, setFileWaiting] = useState<null | { multiple: boolean }>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  // Downloads staged BY the remote page (e.g. a router's "Backup config"
  // button saves to server disk). The server announces each finished one
  // over the socket; files are fetched back over plain HTTP below.
  const [downloads, setDownloads] = useState<
    Array<{ id: string; name: string; size: number; createdAt: number }>
  >([]);
  const [showDownloads, setShowDownloads] = useState(false);
  const [freshDownload, setFreshDownload] = useState<null | { id: string; name: string; size: number }>(
    null
  );

  const downloadUrl = (id: string) => `/api/devices/${deviceId}/downloads/${id}`;

  const refreshDownloads = async () => {
    try {
      const res = await fetch(`/api/devices/${deviceId}/downloads`);
      if (!res.ok) return;
      const body = (await res.json()) as { downloads?: typeof downloads };
      if (Array.isArray(body.downloads)) setDownloads(body.downloads);
    } catch {
      // Server restarting / unreachable - panel just stays as-is.
    }
  };

  const formatBytes = (n: number) => {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };
  // Set once this viewer answers; the modal stays (disabled) until the
  // server confirms the dialog is settled, so a lost response can't leave
  // the remote page paused with no visible dialog.
  const [dialogResponded, setDialogResponded] = useState(false);

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
    setRemoteDialog(null);
    setDialogResponded(false);
    setFileWaiting(null);
    setUploadNote(null);
    setUploading(false);
    setFreshDownload(null);
    setShowDownloads(false);
    refreshDownloads();

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
        let msg: {
          type: string;
          data?: string;
          message?: string;
          width?: number;
          height?: number;
          dialogType?: string;
          defaultValue?: string;
          multiple?: boolean;
          name?: string;
          id?: string;
          size?: number;
        };
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
        } else if (msg.type === 'fileChooser') {
          // Remote <input type=file> was clicked - it is blocked until we
          // send a file. Prompt the user to pick one from this machine.
          setFileWaiting({ multiple: !!msg.multiple });
          setUploadNote('The remote page is waiting for a file — choose one from this device.');
        } else if (msg.type === 'fileReady' && msg.name) {
          setUploading(false);
          // If a picker was already open the server delivers immediately
          // (a fileConsumed follows); otherwise the file is staged for the
          // next Browse click.
          setUploadNote(`“${msg.name}” uploaded — now click Browse / Choose File in the remote page.`);
        } else if (msg.type === 'fileConsumed') {
          setFileWaiting(null);
          setUploading(false);
          setUploadNote('File delivered to the remote page.');
        } else if (msg.type === 'fileChooserTimeout') {
          setFileWaiting(null);
          setUploading(false);
          setUploadNote('Remote file picker timed out — click Browse in the page and try again.');
        } else if (msg.type === 'fileError') {
          setUploading(false);
          setUploadNote(msg.message || 'File upload failed.');
        } else if (msg.type === 'downloadReady' && msg.id && msg.name) {
          // A remote download finished on the server - refresh the panel
          // list and surface a one-click save link.
          setFreshDownload({ id: String(msg.id), name: String(msg.name), size: Number(msg.size) || 0 });
          refreshDownloads();
        } else if (msg.type === 'dialog' && msg.dialogType) {
          setRemoteDialog({
            dialogType: msg.dialogType,
            message: msg.message || '',
            defaultValue: msg.defaultValue || '',
          });
          setPromptText(msg.defaultValue || '');
          setDialogResponded(false);
        } else if (msg.type === 'dialogClosed') {
          setRemoteDialog(null);
          setDialogResponded(false);
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

  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || '');
        const comma = url.indexOf(',');
        resolve(comma >= 0 ? url.slice(comma + 1) : url);
      };
      reader.onerror = () => reject(reader.error || new Error('Could not read file'));
      reader.readAsDataURL(file);
    });

  const sendFile = async (file: File) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setUploadNote('Not connected — reconnect, then try the upload again.');
      return;
    }
    if (file.size <= 0) {
      setUploadNote(`“${file.name}” is empty — pick a file with content.`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadNote(`“${file.name}” is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`);
      return;
    }
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    setUploading(true);
    setUploadNote(`Uploading “${file.name}”…`);
    try {
      ws.send(JSON.stringify({ type: 'fileStart', id, name: file.name, size: file.size }));
      const base64 = await readFileAsBase64(file);
      for (let i = 0; i < base64.length; i += UPLOAD_CHUNK_CHARS) {
        if (wsRef.current !== ws || ws.readyState !== WebSocket.OPEN) {
          throw new Error('Connection lost during upload');
        }
        ws.send(JSON.stringify({ type: 'fileChunk', id, data: base64.slice(i, i + UPLOAD_CHUNK_CHARS) }));
        // Yield so the socket can flush and the UI stays responsive.
        await new Promise((r) => setTimeout(r, 0));
      }
      ws.send(JSON.stringify({ type: 'fileEnd', id }));
    } catch (err) {
      setUploading(false);
      try {
        ws.send(JSON.stringify({ type: 'fileCancel', id }));
      } catch {}
      setUploadNote(err instanceof Error ? err.message : 'Upload failed.');
    }
  };

  const onFilesPicked = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    // Fire-and-forget sequentially so multiple files arrive in order.
    (async () => {
      for (const file of Array.from(files)) {
        // eslint-disable-next-line no-await-in-loop
        await sendFile(file);
      }
    })().catch(() => {});
  };

  const openFilePicker = () => {
    const input = fileInputRef.current;
    if (!input) return;
    // Respect the remote input's `multiple` when the server reported it.
    input.multiple = fileWaiting ? fileWaiting.multiple : true;
    input.click();
  };

  const respondDialog = (accept: boolean) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !remoteDialog || dialogResponded) return;
    ws.send(
      JSON.stringify(
        accept
          ? remoteDialog.dialogType === 'prompt'
            ? { type: 'dialogAccept', text: promptText }
            : { type: 'dialogAccept' }
          : { type: 'dialogDismiss' }
      )
    );
    setDialogResponded(true);
  };

  const dialogTitle =
    remoteDialog?.dialogType === 'confirm'
      ? 'Confirm'
      : remoteDialog?.dialogType === 'prompt'
        ? 'Prompt'
        : remoteDialog?.dialogType === 'beforeunload'
          ? 'Leave page?'
          : 'Alert';
  const dialogMessage =
    remoteDialog && (remoteDialog.message || remoteDialog.dialogType !== 'beforeunload')
      ? remoteDialog.message
      : 'This page is asking you to confirm that you want to leave.';
  const dialogDismissLabel = remoteDialog?.dialogType === 'beforeunload' ? 'Stay' : 'Cancel';
  const dialogAcceptLabel = remoteDialog?.dialogType === 'beforeunload' ? 'Leave' : 'OK';

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

      <div className="absolute right-3 top-3 flex gap-2">
        <div className="relative">
          <button
            onClick={() => {
              setShowDownloads((v) => !v);
              if (!showDownloads) refreshDownloads();
            }}
            title="Files downloaded by the remote page"
            className="relative rounded bg-graphite-900/80 p-2 text-neutral-300 hover:bg-graphite-800 hover:text-neutral-100"
          >
            <Download size={14} />
            {downloads.length > 0 && (
              <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-signal px-1 text-[10px] font-semibold text-graphite-950">
                {downloads.length}
              </span>
            )}
          </button>
          {showDownloads && (
            <div className="absolute right-0 top-9 z-20 w-72 max-w-[80vw] rounded-lg border border-graphite-600 bg-graphite-900 p-2 shadow-xl">
              <p className="px-1 pb-1 text-xs font-semibold text-neutral-200">Remote downloads</p>
              {downloads.length === 0 ? (
                <p className="px-1 py-2 text-xs text-neutral-500">
                  Nothing yet — files the device UI saves (backups, exports) will appear here.
                </p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto">
                  {downloads.map((d) => (
                    <li key={d.id}>
                      <a
                        href={downloadUrl(d.id)}
                        className="flex items-center justify-between gap-2 rounded px-1.5 py-1.5 text-xs text-neutral-300 hover:bg-graphite-800 hover:text-neutral-100"
                        title={`Save ${d.name}`}
                      >
                        <span className="min-w-0 flex-1 truncate">{d.name}</span>
                        <span className="shrink-0 text-neutral-500">{formatBytes(d.size)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <button
          onClick={openFilePicker}
          title="Upload a file from this device into the remote page (e.g. firmware image)"
          className="rounded bg-graphite-900/80 p-2 text-neutral-300 hover:bg-graphite-800 hover:text-neutral-100"
        >
          <Upload size={14} />
        </button>
        <button
          onClick={reload}
          title="Reload"
          className="rounded bg-graphite-900/80 p-2 text-neutral-300 hover:bg-graphite-800 hover:text-neutral-100"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          onFilesPicked(e.target.files);
          e.target.value = '';
        }}
      />

      {(fileWaiting || uploadNote) && (
        <div className="absolute inset-x-0 bottom-3 z-10 flex justify-center px-4">
          <div className="flex max-w-xl flex-wrap items-center justify-center gap-2 rounded-lg border border-graphite-600 bg-graphite-900/95 px-3 py-2 text-center text-xs text-neutral-300">
            {fileWaiting ? (
              <>
                <span>Remote page is waiting for a file — pick one from this device.</span>
                <button
                  onClick={openFilePicker}
                  disabled={uploading}
                  className="rounded bg-signal px-2.5 py-1 font-medium text-graphite-950 hover:bg-signal/90 disabled:opacity-50"
                >
                  {uploading ? 'Uploading…' : 'Choose file'}
                </button>
              </>
            ) : (
              <>
                <span className="break-all">{uploadNote}</span>
                {uploading ? null : (
                  <button onClick={() => setUploadNote(null)} className="text-neutral-500 hover:text-neutral-200">
                    Dismiss
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {freshDownload && !fileWaiting && (
        <div className="absolute inset-x-0 top-3 z-10 flex justify-center px-4">
          <div className="flex max-w-xl flex-wrap items-center justify-center gap-2 rounded-lg border border-graphite-600 bg-graphite-900/95 px-3 py-2 text-center text-xs text-neutral-300">
            <span className="break-all">
              Remote page saved “{freshDownload.name}”
              {freshDownload.size ? ` (${formatBytes(freshDownload.size)})` : ''}.
            </span>
            <a
              href={downloadUrl(freshDownload.id)}
              className="rounded bg-signal px-2.5 py-1 font-medium text-graphite-950 hover:bg-signal/90"
            >
              Save to this device
            </a>
            <button
              onClick={() => setFreshDownload(null)}
              className="text-neutral-500 hover:text-neutral-200"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

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
      {remoteDialog && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-4">
          <div
            role="alertdialog"
            aria-label={dialogTitle}
            onKeyDown={(e) => {
              if (e.key === 'Escape') respondDialog(false);
            }}
            className="w-full max-w-sm space-y-3 rounded-lg border border-graphite-600 bg-graphite-900 p-4"
          >
            <h2 className="text-sm font-semibold text-neutral-100">{dialogTitle}</h2>
            <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm text-neutral-300">
              {dialogMessage}
            </p>
            {remoteDialog.dialogType === 'prompt' && (
              <input
                autoFocus
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') respondDialog(true);
                }}
                disabled={dialogResponded}
                className="w-full rounded border border-graphite-600 bg-graphite-800 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-signal disabled:opacity-50"
              />
            )}
            <div className="flex justify-end gap-2 pt-1">
              {remoteDialog.dialogType !== 'alert' && (
                <button
                  onClick={() => respondDialog(false)}
                  disabled={dialogResponded}
                  className="px-3 py-1.5 text-sm text-neutral-400 hover:text-neutral-100 disabled:opacity-50"
                >
                  {dialogDismissLabel}
                </button>
              )}
              <button
                autoFocus={remoteDialog.dialogType !== 'prompt'}
                onClick={() => respondDialog(true)}
                disabled={dialogResponded}
                className="rounded bg-signal px-3 py-1.5 text-sm font-medium text-graphite-950 hover:bg-signal/90 disabled:opacity-50"
              >
                {dialogAcceptLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

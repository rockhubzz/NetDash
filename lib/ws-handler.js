const browserManager = require('./browser-manager');

function handleConnection(ws, deviceId, viewport) {
  browserManager.attach(deviceId, ws, viewport).catch((err) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: err.message || 'Failed to open device' }));
    }
    ws.close();
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'viewport') {
      browserManager.handleViewport(deviceId, ws, msg);
      return;
    }
    // File-upload bridging (viewer host -> remote page). Handled here so
    // large base64 chunks never reach the input-replay path.
    if (
      msg.type === 'fileStart' ||
      msg.type === 'fileChunk' ||
      msg.type === 'fileEnd' ||
      msg.type === 'fileCancel'
    ) {
      browserManager.handleFileMessage(deviceId, ws, msg).catch(() => {});
      return;
    }
    browserManager.handleInput(deviceId, msg).catch(() => {});
  });

  ws.on('close', () => {
    browserManager.detach(deviceId, ws);
  });
}

module.exports = { handleConnection };

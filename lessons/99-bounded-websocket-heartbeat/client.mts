import { randomBytes } from 'node:crypto';
import { request, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Decoder, encodeFrame } from './codec.mts';
import { fields, upgradeHeaders, websocketAccept } from './handshake.mts';
import { boundedWriter, CloseState, closeWindow } from './transport.mts';

const MESSAGE = 'Xin chào WebSocket';
const LIFETIME = 3000;

export function validSwitchingResponse(response: IncomingMessage, expectedAccept: string): boolean {
  const accept = fields(response, 'sec-websocket-accept');
  return response.httpVersion === '1.1' && response.statusCode === 101 &&
    upgradeHeaders(response) && accept.length === 1 && accept[0] === expectedAccept &&
    ['sec-websocket-extensions', 'sec-websocket-protocol', 'content-length',
      'transfer-encoding', 'trailer', 'content-encoding'].every((name) => fields(response, name).length === 0);
}

function exchange(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const expectedAccept = websocketAccept(key);
    const deadline = performance.now() + LIFETIME;
    const decoder = new Decoder(false);
    let socket: Duplex | undefined;
    let writer: ReturnType<typeof boundedWriter> | undefined;
    let closing: ReturnType<typeof closeWindow> | undefined;
    const closeState = new CloseState();
    let echoReceived = false;
    let normalPeerClose = false;
    let settled = false;

    const upgrade = request({
      hostname: '127.0.0.1', port, path: '/events', method: 'GET',
      agent: false, maxHeaderSize: 8192,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
      },
    });
    upgrade.maxHeadersCount = 0;
    const timer = setTimeout(() => finish('timeout'), LIFETIME);

    function finish(error?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      closing?.cancel();
      writer?.cancel();
      socket?.off('data', feed);
      socket?.destroy();
      upgrade.destroy();
      if (error) reject(new Error(error));
      else resolve();
    }

    function timely(): boolean {
      if (settled) return false;
      if (performance.now() >= deadline) finish('timeout');
      else if (closing?.expired()) finish('close_timeout');
      return !settled;
    }

    function send(opcode: number, payload: Buffer): boolean {
      if (writer?.send(encodeFrame(opcode, payload, true))) return true;
      finish('connection_failed');
      return false;
    }

    function endIfReady(): void {
      if (closeState.received && writer?.empty()) socket?.end();
    }

    function sendClose(payload: Buffer): boolean {
      if (!closeState.begin()) return true;
      closing = closeWindow(() => finish('close_timeout'));
      return send(8, payload);
    }

    function feed(data: Buffer): void {
      if (!timely()) return;
      decoder.feed(data, (event) => {
        if (!timely()) return false;
        switch (event.kind) {
          case 'error':
            finish(`frame_${event.code}`);
            return false;
          case 'text':
            if (closeState.sent) return;
            if (event.text !== MESSAGE) {
              finish('unexpected_message');
              return false;
            }
            echoReceived = true;
            return sendClose(Buffer.from([3, 232]));
          case 'ping':
            if (closeState.acceptsPing) return send(10, event.payload);
            return;
          case 'close':
            closeState.receive();
            normalPeerClose = event.payload.length >= 2 && event.payload.readUInt16BE(0) === 1000;
            if (sendClose(event.payload)) endIfReady();
            return false;
        }
      });
    }

    upgrade.on('error', () => { if (timely()) finish('connection_failed'); });
    upgrade.once('response', (response) => {
      response.destroy();
      if (timely()) finish('invalid_upgrade');
    });
    upgrade.once('upgrade', (response, upgraded, head) => {
      socket = upgraded;
      function onError(): void { if (timely()) finish('connection_failed'); }
      socket.on('error', onError);
      socket.once('close', () => {
        upgraded.off('error', onError);
        if (timely()) finish(echoReceived && normalPeerClose ? undefined : 'unexpected_close');
      });
      if (!timely()) {
        upgraded.destroy();
        return;
      }
      if (!validSwitchingResponse(response, expectedAccept)) {
        finish('invalid_upgrade');
        return;
      }
      writer = boundedWriter(socket, endIfReady);
      socket.on('data', feed);
      if (send(1, Buffer.from(MESSAGE)) && head.length) feed(head);
    });
    upgrade.end();
  });
}

if (import.meta.main) {
  try {
    const portText = process.env.PORT ?? '8099';
    const port = Number(portText);
    if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) throw new Error('invalid_port');
    await exchange(port);
    console.log(JSON.stringify({ echo: MESSAGE, closeCode: 1000 }));
  } catch (error) {
    const code = error instanceof Error ? error.message : 'connection_failed';
    console.error(JSON.stringify({ error: { code, message: code } }));
    process.exitCode = 1;
  }
}

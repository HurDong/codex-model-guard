import net from 'node:net';
import { randomUUID } from 'node:crypto';

const MAX_FRAME = 8 * 1024 * 1024;

// The bundled codex-app-tools plugin uses this length-prefixed local pipe.
// Never log its path or reconnect/retry a potentially accepted mutation.
export class AppToolsClient {
  constructor(pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH, timeoutMs = 10000) {
    if (!pipePath) throw new Error('app_pipe_unavailable');
    this.pipePath = pipePath;
    this.timeoutMs = timeoutMs;
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const socket = net.createConnection(this.pipePath);
      let buffer = Buffer.alloc(0), done = false, written = false;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) { error.deliveryUnknown = written; reject(error); }
        else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error('app_pipe_timeout')), this.timeoutMs);
      socket.on('error', () => finish(new Error('app_pipe_connection_failed')));
      socket.on('close', () => finish(new Error('app_pipe_closed')));
      socket.on('connect', () => {
        const body = Buffer.from(JSON.stringify({id, jsonrpc:'2.0', method, params}));
        if (body.length > MAX_FRAME) return finish(new Error('app_request_too_large'));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        written = true;
        socket.write(Buffer.concat([header, body]));
      });
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (length > MAX_FRAME) return finish(new Error('app_response_too_large'));
          if (buffer.length < length + 4) return;
          let message;
          try { message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8')); }
          catch { return finish(new Error('app_response_invalid')); }
          buffer = buffer.subarray(length + 4);
          if (message.id !== id) continue;
          if (message.error) {
            const error = new Error('app_request_rejected');
            error.rpcCode = message.error.code;
            return finish(error);
          }
          return finish(null, message.result);
        }
      });
    });
  }
  async listTools() {
    const result = await this.request('tools/list', {threadStartKind:'all'});
    if (!Array.isArray(result?.tools)) throw new Error('app_catalog_invalid');
    return result.tools;
  }
  async callForThread(threadId, tool, args, sourceTurnId) {
    if (!/^[a-f0-9-]{36}$/i.test(threadId)) throw new Error('invalid_thread_id');
    if (!['read_thread', 'send_message_to_thread'].includes(tool)) throw new Error('unsupported_app_tool');
    if (args.threadId !== threadId) throw new Error('target_thread_mismatch');
    const result = await this.request('tools/call', {
      arguments:args, callerSource:'codex', namespace:'codex_app',
      threadId, hostId:'local', tool,
      callId:`first-prompt-${randomUUID()}`, turnId:sourceTurnId ?? `first-prompt-${randomUUID()}`
    });
    if (result?.success !== true) {
      const error = new Error('app_tool_failed');
      error.deliveryUnknown = tool === 'send_message_to_thread';
      throw error;
    }
    const item = result.contentItems?.find(item => item.type === 'inputText');
    try { return JSON.parse(item?.text); }
    catch { throw new Error('app_tool_response_invalid'); }
  }
  readThread(threadId) {
    return this.callForThread(threadId, 'read_thread', {
      threadId, hostId:'local', turnLimit:1, includeOutputs:false, maxOutputCharsPerItem:0
    });
  }
  send(threadId, prompt, selection, sourceTurnId) {
    return this.callForThread(threadId, 'send_message_to_thread', {
      threadId, hostId:'local', prompt, model:selection.model, thinking:selection.effort
    }, sourceTurnId);
  }
}

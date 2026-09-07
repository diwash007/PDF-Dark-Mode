/*
 * A tiny WebSocket + Chrome DevTools Protocol client.
 *
 * The sandbox has no npm access, so this stands in for puppeteer. It only needs
 * to do three things: connect, send commands, and surface events.
 */

const http = require("node:http");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");

/* ------------------------------------------------------------- websocket */

class Ws extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on("close", () => this.emit("close"));
    socket.on("error", (e) => this.emit("error", e));
  }

  drain() {
    for (;;) {
      if (this.buffer.length < 2) return;

      const first = this.buffer[0];
      const opcode = first & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        length = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let mask;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + length) return;

      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (mask) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x1) this.emit("message", payload.toString("utf8"));
      else if (opcode === 0x8) this.close();
      else if (opcode === 0x9) this.frame(0xa, payload); // pong
    }
  }

  frame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const data = Buffer.from(payload);
    for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i % 4];

    let header;
    if (data.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }

    this.socket.write(Buffer.concat([header, mask, data]));
  }

  send(text) {
    this.frame(0x1, Buffer.from(text, "utf8"));
  }

  close() {
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
  }
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.setNoDelay(true);
      resolve(new Ws(socket));
    });
    req.on("error", reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ cdp */

class Cdp extends EventEmitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();

    ws.on("message", (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }

      if (msg.method) this.emit("event", msg);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20000);
    });
  }

  close() {
    this.ws.close();
  }
}

async function httpJson(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function connect(port) {
  const version = await httpJson(port, "/json/version");
  const ws = await openSocket(version.webSocketDebuggerUrl);
  return new Cdp(ws);
}

module.exports = { connect, httpJson, openSocket, Cdp };

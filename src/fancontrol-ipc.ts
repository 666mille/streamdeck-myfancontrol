// Minimal client for FanControl's own IPC: gRPC over the named pipe "FanControl"
// using the GrpcDotNetNamedPipes transport (delimited TransportMessage + inline payload).
// Windows: message-mode pipe, no size prefix. Other OS (tests): 4-byte size prefix.
import net from "node:net";

export const SensorType = {
    Unsupported: 0, Control: 1, RPM: 2, Temperature: 3, UsagePercent: 4,
    Frequency: 5, Voltage: 6, Power: 7, Data: 8,
} as const;

export interface FcSensor {
    id: string;
    type: number;
    name: string;
    origin: string;
    value: number | null;
}

export interface FcConfigs {
    configs: string[];
    currentConfig: string;
    configFolder: string;
}

export class IpcError extends Error {
    constructor(message: string, readonly code: "connect" | "timeout" | "status" | "protocol") { super(message); }
}

const PIPE = process.env.FANCONTROL_PIPE ?? (process.platform === "win32" ? "\\\\.\\pipe\\FanControl" : "/tmp/CoreFxPipe_FanControl");
const SIZE_PREFIX = process.env.FANCONTROL_PIPE_PREFIX ? process.env.FANCONTROL_PIPE_PREFIX === "1" : process.platform !== "win32";

// ---------- protobuf helpers ----------

function varint(n: number): number[] {
    const out: number[] = [];
    let v = n >>> 0;
    while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
    out.push(v);
    return out;
}

function fieldBytes(no: number, data: Buffer): Buffer {
    return Buffer.concat([Buffer.from([...varint((no << 3) | 2), ...varint(data.length)]), data]);
}

function fieldVarint(no: number, v: number): Buffer {
    return Buffer.from([...varint(no << 3), ...varint(v)]);
}

const str = (s: string) => Buffer.from(s, "utf8");

function delimited(msg: Buffer): Buffer {
    return Buffer.concat([Buffer.from(varint(msg.length)), msg]);
}

type Field = { no: number; wire: number; num?: number; buf?: Buffer };

class Reader {
    pos = 0;
    constructor(readonly buf: Buffer, start = 0, readonly end = buf.length) { this.pos = start; }
    get done() { return this.pos >= this.end; }
    varint(): number {
        let result = 0, shift = 0, b: number;
        do {
            if (this.pos >= this.end) throw new RangeError("varint");
            b = this.buf[this.pos++];
            if (shift < 32) result += (b & 0x7f) * 2 ** shift;
            shift += 7;
        } while (b & 0x80);
        return result;
    }
    field(): Field {
        const tag = this.varint();
        const no = tag >>> 3, wire = tag & 7;
        switch (wire) {
            case 0: return { no, wire, num: this.varint() };
            case 1: { const buf = this.take(8); return { no, wire, buf }; }
            case 2: { const len = this.varint(); return { no, wire, buf: this.take(len) }; }
            case 5: { const buf = this.take(4); return { no, wire, buf }; }
            default: throw new IpcError(`wire type ${wire}`, "protocol");
        }
    }
    take(n: number): Buffer {
        if (this.pos + n > this.end) throw new RangeError("take");
        const b = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return b;
    }
}

function fields(buf: Buffer): Field[] {
    const r = new Reader(buf);
    const out: Field[] = [];
    while (!r.done) out.push(r.field());
    return out;
}

// ---------- transport ----------

function buildRequest(method: string, payload: Buffer): Buffer {
    const init = fieldBytes(1, fieldBytes(1, str(method)));
    const headers = fieldBytes(2, Buffer.alloc(0));
    const info = fieldBytes(3, Buffer.concat([payload.length ? fieldVarint(1, payload.length) : Buffer.alloc(0), fieldVarint(2, 1)]));
    const packet = Buffer.concat([delimited(init), delimited(headers), delimited(info), payload]);
    if (!SIZE_PREFIX) return packet;
    const prefix = Buffer.alloc(4);
    prefix.writeInt32LE(packet.length);
    return Buffer.concat([prefix, packet]);
}

/** Parses the response stream; returns the payload once trailers arrived, undefined if incomplete. */
function parseResponse(data: Buffer): { payload: Buffer } | undefined {
    const r = new Reader(data);
    let payload = Buffer.alloc(0);
    let trailing = -1; // large payloads (>15 KiB on Windows) follow the packet, i.e. come after the trailers
    try {
        while (!r.done) {
            const msg = r.take(r.varint());
            for (const f of fields(msg)) {
                if (f.no === 3 && f.buf) {
                    let size = 0, inSame = false;
                    for (const p of fields(f.buf)) {
                        if (p.no === 1) size = p.num ?? 0;
                        if (p.no === 2) inSame = !!p.num;
                    }
                    if (inSame) payload = Buffer.from(r.take(size));
                    else trailing = size;
                } else if (f.no === 5 && f.buf) {
                    let status = 0, detail = "";
                    for (const t of fields(f.buf)) {
                        if (t.no === 2) status = t.num ?? 0;
                        if (t.no === 3) detail = t.buf?.toString("utf8") ?? "";
                    }
                    if (status !== 0) throw new IpcError(`status ${status} ${detail}`.trim(), "status");
                    if (trailing >= 0) payload = Buffer.from(r.take(trailing));
                    return { payload };
                }
            }
        }
    } catch (e) {
        if (e instanceof RangeError) return undefined;
        throw e;
    }
    return undefined;
}

/** Strips 4-byte size prefixes (non-Windows framing) and returns the concatenated packets. */
function unframe(chunks: Buffer): Buffer {
    if (!SIZE_PREFIX) return chunks;
    const parts: Buffer[] = [];
    let pos = 0;
    while (pos + 4 <= chunks.length) {
        const len = chunks.readInt32LE(pos);
        if (pos + 4 + len > chunks.length) break;
        parts.push(chunks.subarray(pos + 4, pos + 4 + len));
        pos += 4 + len;
    }
    return Buffer.concat(parts);
}

export function callUnary(method: string, payload: Buffer, timeoutMs = 2000, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let data = Buffer.alloc(0);
        let settled = false;
        const sock = net.connect(PIPE);
        const finish = (err: Error | null, result?: Buffer) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            sock.destroy();
            err ? reject(err) : resolve(result!);
        };
        const onAbort = () => finish(new IpcError("aborted", "timeout"));
        const timer = setTimeout(() => finish(new IpcError("timeout", "timeout")), timeoutMs);
        signal?.addEventListener("abort", onAbort);

        sock.on("connect", () => sock.write(buildRequest(method, payload)));
        sock.on("data", (chunk: Buffer) => {
            data = Buffer.concat([data, chunk]);
            try {
                const res = parseResponse(unframe(data));
                if (res) finish(null, res.payload);
            } catch (e) {
                finish(e as Error);
            }
        });
        sock.on("error", (e: any) => finish(new IpcError(e?.code ?? String(e), "connect")));
        sock.on("close", () => finish(new IpcError("pipe closed", "protocol")));
    });
}

// ---------- RPC methods ----------

export async function getAllSensors(signal?: AbortSignal): Promise<FcSensor[]> {
    const payload = await callUnary("/SensorsRPC/GetAllSensors", Buffer.alloc(0), 2000, signal);
    const list: FcSensor[] = [];
    for (const f of fields(payload)) {
        if (f.no !== 1 || !f.buf) continue;
        const s: FcSensor = { id: "", type: 0, name: "", origin: "", value: null };
        for (const p of fields(f.buf)) {
            if (p.no === 1) s.id = p.buf!.toString("utf8");
            else if (p.no === 2) s.type = p.num ?? 0;
            else if (p.no === 3) s.name = p.buf!.toString("utf8");
            else if (p.no === 4) s.origin = p.buf!.toString("utf8");
            else if (p.no === 5 && p.buf) s.value = p.buf.readFloatLE(0);
        }
        if (s.id) list.push(s);
    }
    return list;
}

export async function listAvailableConfigs(signal?: AbortSignal): Promise<FcConfigs> {
    const payload = await callUnary("/FanControlRPC/ListAvailableConfigs", Buffer.alloc(0), 2000, signal);
    const res: FcConfigs = { configs: [], currentConfig: "", configFolder: "" };
    for (const f of fields(payload)) {
        const s = f.buf?.toString("utf8") ?? "";
        if (f.no === 1) res.configs.push(s);
        else if (f.no === 2) res.currentConfig = s;
        else if (f.no === 3) res.configFolder = s;
    }
    return res;
}

export async function loadConfig(path: string): Promise<number> {
    const payload = await callUnary("/FanControlRPC/LoadConfig", fieldBytes(1, str(path)), 5000);
    for (const f of fields(payload)) if (f.no === 1) return f.num ?? 0;
    return 0;
}

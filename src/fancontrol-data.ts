// Polls FanControl's IPC once per second and publishes all sensors (with nicknames from the active config).
import fs from "node:fs";
import path from "node:path";
import { getAllSensors, listAvailableConfigs, IpcError, type FcSensor } from "./fancontrol-ipc.js";
import { isShuttingDown, onShutdown } from "./lifecycle.js";

export type FcStatus = "connecting" | "ok" | "offline" | "notready" | "error";

export interface FcElement extends FcSensor {
    label: string;
}

export interface FcSnapshot {
    status: FcStatus;
    error: string;
    profile: string;
    elements: FcElement[];
    byId: Map<string, FcElement>;
}

const POLL_MS = 1000;
const NICK_REFRESH_MS = 30000;

type Listener = (snap: FcSnapshot) => void;

class FanControlData {
    private timer: NodeJS.Timeout | null = null;
    private busy = false;
    private abort: AbortController | null = null;
    private listeners = new Set<Listener>();
    private nicknames = new Map<string, string>();
    private nickKey = "";
    private nickTime = 0;
    private profile = "";
    private idsSignature = "";

    snapshot: FcSnapshot = { status: "connecting", error: "", profile: "", elements: [], byId: new Map() };

    constructor() {
        onShutdown(() => this.stop());
    }

    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        if (!this.timer && !isShuttingDown()) {
            this.timer = setInterval(() => this.poll(), POLL_MS);
            this.poll();
        }
        return () => {
            this.listeners.delete(fn);
            if (this.listeners.size === 0) this.stop();
        };
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.abort?.abort();
        this.abort = null;
    }

    private publish(snap: FcSnapshot): void {
        this.snapshot = snap;
        for (const fn of this.listeners) {
            try { fn(snap); } catch { /* listener errors must not stop polling */ }
        }
    }

    /** Identifier -> NickName from the active FanControl config (all arrays under "FanControl"). */
    private async refreshNicknames(signal: AbortSignal): Promise<void> {
        const cfg = await listAvailableConfigs(signal);
        const file = path.isAbsolute(cfg.currentConfig) ? cfg.currentConfig : path.join(cfg.configFolder, cfg.currentConfig);
        this.profile = path.basename(file, path.extname(file));
        let key = file;
        try { key += ":" + fs.statSync(file).mtimeMs; } catch { /* config not readable */ }
        if (key === this.nickKey) return;
        this.nickKey = key;
        this.nicknames.clear();
        try {
            const root = JSON.parse(fs.readFileSync(file, "utf-8"))?.FanControl ?? {};
            for (const list of Object.values(root)) {
                if (!Array.isArray(list)) continue;
                for (const e of list) {
                    if (e && typeof e.Identifier === "string" && typeof e.NickName === "string" && e.NickName.trim()) {
                        this.nicknames.set(e.Identifier, e.NickName.trim());
                    }
                }
            }
        } catch { /* keep RPC names */ }
    }

    private async poll(): Promise<void> {
        if (this.busy || isShuttingDown()) return;
        this.busy = true;
        const ctrl = new AbortController();
        this.abort = ctrl;
        try {
            const sensors = await getAllSensors(ctrl.signal);
            if (sensors.length === 0) {
                this.publish({ ...this.snapshot, status: "notready", error: "" });
                return;
            }

            const sig = sensors.map((s) => s.id).join("|");
            const now = Date.now();
            if (sig !== this.idsSignature || now - this.nickTime > NICK_REFRESH_MS) {
                this.idsSignature = sig;
                this.nickTime = now;
                try { await this.refreshNicknames(ctrl.signal); } catch { /* names are optional */ }
            }

            const elements = sensors.map((s) => ({ ...s, label: this.nicknames.get(s.id) ?? s.name }));
            if (!isShuttingDown()) {
                this.publish({
                    status: "ok", error: "", profile: this.profile, elements,
                    byId: new Map(elements.map((e) => [e.id, e])),
                });
            }
        } catch (e) {
            if (isShuttingDown()) return;
            const offline = e instanceof IpcError && (e.code === "connect" || e.code === "timeout");
            this.idsSignature = "";
            this.publish({
                ...this.snapshot,
                status: offline ? "offline" : "error",
                error: e instanceof Error ? e.message : String(e),
                byId: new Map(),
            });
        } finally {
            this.busy = false;
            if (this.abort === ctrl) this.abort = null;
        }
    }
}

export const fanControlData = new FanControlData();

import streamDeck, {
    action,
    SingletonAction,
    type JsonObject,
    type KeyDownEvent,
    type WillAppearEvent,
    type WillDisappearEvent,
    type DidReceiveSettingsEvent,
    type PropertyInspectorDidAppearEvent,
} from "@elgato/streamdeck";
import { fanControlData, type FcElement, type FcSnapshot } from "../fancontrol-data.js";
import { SensorType } from "../fancontrol-ipc.js";
import { isShuttingDown } from "../lifecycle.js";

type Kind = "temp" | "fan" | "rpm";
type Unit = "C" | "F";

type SensorSettings = JsonObject & {
    element?: string;
    elementName?: string;
    showHeader?: boolean;
    headerText?: string;
    unit?: Unit;
    thresholdUnit?: Unit;
    decimals?: string;
    level2?: string;
    level3?: string;
    color1?: string;
    color2?: string;
    color3?: string;
    background?: string;
    offlineColor?: string;
    colorMode?: "value" | "background";
    showBar?: boolean;
};

const DEFAULTS = {
    temp: { level2: "60", level3: "80" },
    fan: { level2: "60", level3: "85" },
    rpm: { level2: "", level3: "" },
    color1: "#27AE60",
    color2: "#F1C40F",
    color3: "#C0392B",
    background: "#1A1A1A",
    offlineColor: "#808080",
    errorColor: "#5A1A1A",
};

const sdkLog = streamDeck.logger.createScope("SensorDisplay");
const warn = (...a: unknown[]) => { try { (sdkLog.warn as any)(...a); } catch { /* ignore */ } };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toF = (c: number) => c * 9 / 5 + 32;
const toC = (f: number) => (f - 32) * 5 / 9;

function num(v: unknown): number | null {
    if (v === undefined || v === null || String(v).trim() === "") return null;
    const n = Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : null;
}

function fmt(n: number): string {
    return String(Math.round(n * 10) / 10);
}

function fitSize(text: string, max: number, min = 12): number {
    return Math.max(min, Math.min(max, Math.floor(128 / (0.62 * Math.max(text.length, 1)))));
}

function headerSvg(header: string): string {
    if (!header) return "";
    const h = header.length > 13 ? header.slice(0, 12) + "…" : header;
    return `<text x="10" y="24" text-anchor="start" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="#ffffff">${esc(h)}</text>`;
}

function wrap(bg: string, body: string): string {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" rx="20" fill="${bg}"/>${body}</svg>`;
    return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

function statusIcon(bg: string, text: string, header: string): string {
    const lines = text.split("\n");
    const fs = fitSize(lines.reduce((a, b) => (b.length > a.length ? b : a), ""), 30);
    const lh = Math.round(fs * 1.2);
    const y0 = Math.round(72 - (lh * lines.length) / 2 + fs * 0.85) + (header ? 6 : 0);
    const body = lines
        .map((l, i) => `<text x="72" y="${y0 + i * lh}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fs}" font-weight="bold" fill="#ffffff">${esc(l)}</text>`)
        .join("");
    return wrap(bg, headerSvg(header) + body);
}

function valueIcon(o: { bg: string; color: string; text: string; header: string; bar: number | null; fillBg: boolean }): string {
    const bg = o.fillBg ? o.color : o.bg;
    const fg = o.fillBg ? "#ffffff" : o.color;
    const fs = fitSize(o.text, 40, 16);
    const y = o.bar === null ? 90 : 84;
    let body = headerSvg(o.header) +
        `<text x="72" y="${y}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fs}" font-weight="bold" fill="${fg}">${esc(o.text)}</text>`;
    if (o.bar !== null) {
        const w = Math.round(116 * Math.max(0, Math.min(1, o.bar)));
        body += `<rect x="14" y="108" width="116" height="10" rx="5" fill="${o.fillBg ? "#00000055" : "#333333"}"/>`;
        if (w > 0) body += `<rect x="14" y="108" width="${w}" height="10" rx="5" fill="${fg}"/>`;
    }
    return wrap(bg, body);
}

interface Instance {
    action: any;
    settings: SensorSettings;
    lastImage: string;
}

abstract class SensorDisplayBase extends SingletonAction<SensorSettings> {
    protected abstract readonly kind: Kind;
    private instances = new Map<string, Instance>();
    private unsubscribe: (() => void) | null = null;
    private lastPiPayload = "";

    override onWillAppear(ev: WillAppearEvent<SensorSettings>): void {
        let settings = ev.payload.settings ?? {};
        if (settings.level2 === undefined && settings.level3 === undefined) {
            settings = { ...settings, ...DEFAULTS[this.kind], thresholdUnit: settings.unit ?? "C" };
            if (settings.unit === "F") settings = { ...settings, level2: "140", level3: "176" };
            this.safe(ev.action.setSettings(settings));
        }
        this.instances.set(ev.action.id, { action: ev.action, settings, lastImage: "" });
        if (!this.unsubscribe) this.unsubscribe = fanControlData.subscribe((s) => this.onSnapshot(s));
        this.render(ev.action.id);
    }

    override onWillDisappear(ev: WillDisappearEvent<SensorSettings>): void {
        this.instances.delete(ev.action.id);
        if (this.instances.size === 0 && this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
    }

    override onDidReceiveSettings(ev: DidReceiveSettingsEvent<SensorSettings>): void {
        const inst = this.instances.get(ev.action.id);
        if (!inst) return;
        inst.settings = ev.payload.settings ?? {};
        if (this.kind === "temp") {
            const unit = inst.settings.unit ?? "C";
            if ((inst.settings.thresholdUnit ?? "C") !== unit) this.applyUnit(inst, unit);
        }
        inst.lastImage = "";
        this.render(ev.action.id);
    }

    override onPropertyInspectorDidAppear(_ev: PropertyInspectorDidAppearEvent<SensorSettings>): void {
        this.lastPiPayload = "";
        this.sendPiStatus(fanControlData.snapshot);
    }

    override onKeyDown(ev: KeyDownEvent<SensorSettings>): void {
        if (this.kind !== "temp") return;
        const inst = this.instances.get(ev.action.id);
        if (!inst) return;
        this.applyUnit(inst, (inst.settings.unit ?? "C") === "C" ? "F" : "C");
        inst.lastImage = "";
        this.render(ev.action.id);
    }

    /** Switches the display unit and converts the thresholds so they keep their meaning. */
    private applyUnit(inst: Instance, unit: Unit): void {
        const from = inst.settings.thresholdUnit ?? "C";
        const conv = (v: string | undefined) => {
            const n = num(v);
            if (n === null || from === unit) return v;
            return fmt(unit === "F" ? toF(n) : toC(n));
        };
        const d = DEFAULTS.temp;
        inst.settings = {
            ...inst.settings,
            unit,
            thresholdUnit: unit,
            level2: conv(inst.settings.level2 ?? d.level2),
            level3: conv(inst.settings.level3 ?? d.level3),
        };
        this.safe(inst.action.setSettings(inst.settings));
    }

    private onSnapshot(snap: FcSnapshot): void {
        if (isShuttingDown()) return;
        for (const id of this.instances.keys()) this.render(id);
        this.sendPiStatus(snap);
    }

    private matches(e: FcElement): boolean {
        if (this.kind === "temp") return e.type === SensorType.Temperature;
        if (this.kind === "fan") return e.type === SensorType.Control;
        return e.type === SensorType.RPM;
    }

    private sendPiStatus(snap: FcSnapshot): void {
        const ui = streamDeck.ui.current as any;
        if (!ui || ui.action?.manifestId !== this.manifestId) return;
        const elements = snap.elements
            .filter((e) => this.matches(e))
            .map((e) => ({ id: e.id, name: e.origin ? `${e.label} (${e.origin})` : e.label }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const payload = { command: "fcStatus", kind: this.kind, status: snap.status, error: snap.error, profile: snap.profile, elements };
        const text = JSON.stringify(payload);
        if (text === this.lastPiPayload) return;
        this.lastPiPayload = text;
        this.safe(ui.sendToPropertyInspector(payload));
    }

    private render(id: string): void {
        const inst = this.instances.get(id);
        if (!inst) return;
        const image = this.buildImage(inst, fanControlData.snapshot);
        if (image === inst.lastImage) return;
        inst.lastImage = image;
        this.safe(inst.action.setImage(image));
    }

    private buildImage(inst: Instance, snap: FcSnapshot): string {
        const s = inst.settings;
        const el = s.element ? snap.byId.get(s.element) : undefined;

        if (el && s.elementName !== el.label) {
            inst.settings = { ...s, elementName: el.label };
            this.safe(inst.action.setSettings(inst.settings));
        }

        const name = el?.label ?? s.elementName ?? "";
        const fallback = { temp: "TEMP", fan: "FAN", rpm: "RPM" }[this.kind];
        const header = s.showHeader === false ? "" : (s.headerText?.trim() || name || fallback);
        const bg = s.background || DEFAULTS.background;
        const offline = s.offlineColor || DEFAULTS.offlineColor;

        switch (snap.status) {
            case "connecting": return statusIcon(offline, "...", header);
            case "offline": return statusIcon(offline, "OFFLINE", header);
            case "notready": return statusIcon(offline, "WAIT", header);
            case "error": return statusIcon(DEFAULTS.errorColor, "ERROR", header);
        }
        if (!s.element) return statusIcon(bg, this.kind === "temp" ? "SELECT\nSENSOR" : "SELECT\nFAN", header);
        if (!el) return statusIcon(DEFAULTS.errorColor, "NOT\nFOUND", header);

        const raw = el.value;
        if (raw === null || !Number.isFinite(raw)) return statusIcon(bg, "--", header);

        const decimals = s.decimals === "1" && this.kind !== "rpm" ? 1 : 0;
        let value = raw;
        let text: string;
        let bar: number | null = raw / 100;
        if (this.kind === "temp") {
            const unit = s.unit ?? "C";
            if (unit === "F") value = toF(raw);
            text = `${value.toFixed(decimals)}°${unit}`;
        } else if (this.kind === "fan") {
            text = `${value.toFixed(decimals)}%`;
        } else {
            text = `${Math.round(value)} RPM`;
            bar = null;
        }

        const d = DEFAULTS[this.kind];
        const l2 = num(s.level2 ?? d.level2);
        const l3 = num(s.level3 ?? d.level3);
        const rounded = Number(value.toFixed(decimals));
        let color = s.color1 || DEFAULTS.color1;
        if (l2 !== null && rounded >= l2) color = s.color2 || DEFAULTS.color2;
        if (l3 !== null && rounded >= l3) color = s.color3 || DEFAULTS.color3;

        return valueIcon({
            bg, color, text, header,
            bar: s.showBar === false ? null : bar,
            fillBg: s.colorMode === "background",
        });
    }

    private safe(p: unknown): void {
        if (p && typeof (p as any).catch === "function") {
            (p as Promise<unknown>).catch((err) => { if (!isShuttingDown()) warn("SDK call failed", err); });
        }
    }
}

@action({ UUID: "com.holgermilz.myfancontrol.temperature" })
export class TemperatureDisplay extends SensorDisplayBase {
    protected readonly kind = "temp";
}

@action({ UUID: "com.holgermilz.myfancontrol.fanspeed" })
export class FanSpeedDisplay extends SensorDisplayBase {
    protected readonly kind = "fan";
}

@action({ UUID: "com.holgermilz.myfancontrol.fanrpm" })
export class FanRpmDisplay extends SensorDisplayBase {
    protected readonly kind = "rpm";
}

import streamDeck, {
  action,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
  type DialDownEvent,
  type DialRotateEvent,
  type PropertyInspectorDidAppearEvent,
  type JsonObject,
  type JsonValue,
} from "@elgato/streamdeck";

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, exec } from "node:child_process";
import { promisify } from "node:util";
import { isShuttingDown, onShutdown, lifeLog } from "../lifecycle.js";

const execAsync = promisify(exec);

// Transparent 1x1 pixel image (Base64 SVG) to hide default icons when showing custom errors
const TRANSPARENT_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjwvc3ZnPg==";

// The 3 available control modes
type ControlMode = "MAN" | "AUTO" | "SOFT";

type FanSettings = JsonObject & {
  fanExe?: string;
  jsonFile?: string;
  fanNick?: string;
  mode?: ControlMode;
  bypassUac?: boolean; 
};

type PiMessage =
  | {
      command: "exeResult";
      error: string | null;
      exePath?: string;
      files?: string[];
    }
  | {
      command: "fanList";
      fans: string[];
      error?: string;
    }
  | {
      command: "selection";
      jsonFile: string | null;
      fanNick: string | null;
    }
  | {
      command: "writeError";
      error: string;
    }
  | {
      command: "uacCheck";
      taskExists: boolean;
      vbsExists: boolean;
      adminVbsExists: boolean; // NEU: Check für das zweite Skript
    };

interface FanState {
    mode: ControlMode;
    value: number;          
    curveName: string;      
    availableCurves: string[]; 
}

// The SDK FileTarget uses fs.openSync without try/catch -> a log call can throw
// (e.g. locked log file during shutdown). That's why every log call is wrapped here.
const sdkLog = streamDeck.logger.createScope("FanControlEncoder");
const log = {
  info: (...a: unknown[]) => { try { (sdkLog.info as any)(...a); } catch { /* ignore */ } },
  warn: (...a: unknown[]) => { try { (sdkLog.warn as any)(...a); } catch { /* ignore */ } },
  error: (...a: unknown[]) => { try { (sdkLog.error as any)(...a); } catch { /* ignore */ } },
};

/** Writes JSON atomically (temp file + rename) so a power-off/shutdown never leaves a half-written file. */
function writeJsonSafe(file: string, data: unknown): void {
  const text = JSON.stringify(data, null, 2);
  const tmp = `${file}.sdtmp`;
  try {
    fs.writeFileSync(tmp, text, "utf-8");
    fs.renameSync(tmp, file);
  } catch (e) {
    // Fallback (e.g. FanControl is holding the file open without FILE_SHARE_DELETE)
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    fs.writeFileSync(file, text, "utf-8");
  }
}

/** Escapes text for use inside SVG (fan/curve names may contain & or <). */
function xml(text: string): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * State of ONE dial (per action instance / context).
 * Previously these were single fields shared by all dials: with two dials,
 * one dial's mode selection or pending value affected the other.
 */
interface DialState {
  modeSelectionActive: boolean;
  pendingMode: ControlMode;
  selectModeTimer: NodeJS.Timeout | null;

  // Debounce: collect rotation, write JSON once after 1.2 s
  pendingValueTimer: NodeJS.Timeout | null;
  pendingValue: number | null;
  pendingCurveIndex: number | null;
  pendingJsonPath: string | null;
  pendingFanNick: string | null;
  pendingFanExe: string | null;
  pendingBypassUac: boolean;
  pendingAction: any;

  // For detecting a changed config file in the Property Inspector
  lastJsonPath: string | undefined;
}

function newDialState(): DialState {
  return {
    modeSelectionActive: false,
    pendingMode: "AUTO",
    selectModeTimer: null,
    pendingValueTimer: null,
    pendingValue: null,
    pendingCurveIndex: null,
    pendingJsonPath: null,
    pendingFanNick: null,
    pendingFanExe: null,
    pendingBypassUac: false,
    pendingAction: null,
    lastJsonPath: undefined,
  };
}

@action({ UUID: "com.holgermilz.myfancontrol.increment" })
export class FanControlEncoder extends SingletonAction<FanSettings> {
  // --- STATE PER DIAL (key = action context id) ---
  private dials = new Map<string, DialState>();

  // ERROR FLAGS (system-wide: scheduled task / scripts exist or not)
  private isTaskMissing = false;
  private isVbsMissing = false;        // silent_restart.vbs
  private isAdminVbsMissing = false;   // admin_action.vbs (NEU)

  // Polling interval management
  private activeIntervals = new Map<string, NodeJS.Timeout>();
  
  // Global settings storage
  private currentSettings = new Map<string, FanSettings>();

  // Cache: re-read the JSON only when it actually changed (mtime/size)
  private jsonCache = new Map<string, { mtimeMs: number; size: number; data: any | null }>();

  constructor() {
    super();
    onShutdown(() => this.dispose());
  }

  /** Stops all timers and discards pending writes (called on shutdown). */
  private dispose(): void {
    for (const st of this.dials.values()) {
      if (st.selectModeTimer) clearTimeout(st.selectModeTimer);
      if (st.pendingValueTimer) clearTimeout(st.pendingValueTimer);
      st.selectModeTimer = null;
      st.pendingValueTimer = null;
    }
    for (const t of this.activeIntervals.values()) clearInterval(t);
    this.activeIntervals.clear();
    lifeLog("FanControlEncoder: timers stopped");
  }

  /** State of one dial; created on first access. */
  private dial(contextId: string): DialState {
    let st = this.dials.get(contextId);
    if (!st) {
      st = newDialState();
      this.dials.set(contextId, st);
    }
    return st;
  }

  /** SDK calls return promises; without a catch they become unhandledRejection. */
  private safe(p: unknown, what: string): void {
    if (p && typeof (p as any).catch === "function") {
      (p as Promise<unknown>).catch((err) => {
        if (!isShuttingDown()) log.warn(`${what} failed`, err);
      });
    }
  }

  // ---------- TIMEOUT HELPERS ----------
  
  private clearSelectModeTimeout(st: DialState): void {
      if (st.selectModeTimer) {
          clearTimeout(st.selectModeTimer);
          st.selectModeTimer = null;
      }
  }

  private startSelectModeTimeout(actionObj: any, context: string): void {
      const st = this.dial(context);
      this.clearSelectModeTimeout(st);
      
      st.selectModeTimer = setTimeout(() => {
          st.selectModeTimer = null;
          if (isShuttingDown()) return;
          log.info('Select mode timeout reached, reverting.');
          st.modeSelectionActive = false; 
          
          const settings = this.currentSettings.get(context);
          if (settings) {
              try {
                  this.updateDisplayFromState(actionObj, settings, false);
              } catch (err) { log.error("select mode timeout error", err); }
          }
      }, 3000); 
  }

  // ---------- LIFECYCLE EVENTS ----------

  override onWillAppear(ev: WillAppearEvent<FanSettings>): void {
    const settings = (ev.payload.settings ?? {}) as FanSettings;
    this.currentSettings.set(ev.action.id, settings);

    const st = this.dial(ev.action.id);
    st.modeSelectionActive = false;
    this.clearSelectModeTimeout(st);
    
    // Reset error flags on appearance
    this.isTaskMissing = false; 
    this.isVbsMissing = false;
    this.isAdminVbsMissing = false;

    st.lastJsonPath = settings.jsonFile;

    // Perform initial UAC/File checks asynchronously
    if (settings.bypassUac) {
        this.performUacChecks(settings)
            .then(() => {
                if (!isShuttingDown()) this.updateDisplayFromState(ev.action, settings, false);
            })
            .catch((err) => log.error("performUacChecks failed", err));
    }

    this.updateDisplayFromState(ev.action, settings, true);

    if (settings.fanExe) this.validateExe(settings.fanExe);
    if (settings.jsonFile) this.loadFans(settings.jsonFile);
    this.sendSelectionToPi(settings.jsonFile, settings.fanNick);

    this.startPolling(ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent<FanSettings>): void {
    const id = ev.action.id;
    this.stopPolling(id);

    const st = this.dials.get(id);
    if (st) {
      this.clearSelectModeTimeout(st);
      // Dial leaves the page (page switch/profile switch) while a value is pending:
      // write it now instead of discarding it.
      if (st.pendingValueTimer) {
        clearTimeout(st.pendingValueTimer);
        st.pendingValueTimer = null;
        try {
          this.executePendingWrite(st);
        } catch (err) {
          log.error("executePendingWrite (willDisappear) error", err);
        }
      }
      this.dials.delete(id);
    }
    this.currentSettings.delete(id);
  }

  override async onPropertyInspectorDidAppear(
    ev: PropertyInspectorDidAppearEvent<FanSettings>,
  ): Promise<void> {
    try {
      const settings = ((await ev.action.getSettings()) ?? {}) as FanSettings;
      
      if (settings.fanExe) this.validateExe(settings.fanExe);
      if (settings.jsonFile) this.loadFans(settings.jsonFile);
      this.sendSelectionToPi(settings.jsonFile, settings.fanNick);

      if (settings.bypassUac) {
          await this.performUacChecks(settings);
          this.sendUacStatusToPi();
          this.updateDisplayFromState(ev.action, settings, false);
      }

    } catch (err) {
      log.error("onPropertyInspectorDidAppear error", err);
    }
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<FanSettings>,
  ): Promise<void> {
    try {
      await this.handleDidReceiveSettings(ev);
    } catch (err) {
      log.error("onDidReceiveSettings error", err);
    }
  }

  private async handleDidReceiveSettings(
    ev: DidReceiveSettingsEvent<FanSettings>,
  ): Promise<void> {
    if (isShuttingDown()) return;
    const settings = (ev.payload.settings ?? {}) as FanSettings;
    this.currentSettings.set(ev.action.id, settings);

    const st = this.dial(ev.action.id);
    st.modeSelectionActive = false;
    this.clearSelectModeTimeout(st);
    this.clearPendingValue(st);

    // 1. Perform UAC and File checks
    if (settings.bypassUac === true) {
        await this.performUacChecks(settings);
        this.sendUacStatusToPi();

        if (this.isTaskMissing || this.isVbsMissing || this.isAdminVbsMissing) {
            this.safe(ev.action.showAlert(), "showAlert"); 
        }
    } else {
        this.isTaskMissing = false; 
        this.isVbsMissing = false;
        this.isAdminVbsMissing = false;
        // Reset errors in Property Inspector
        this.sendToPi({ command: "uacCheck", taskExists: true, vbsExists: true, adminVbsExists: true });
    }

    // 2. Handle path changes and restart logic
    if (settings.jsonFile && settings.jsonFile !== st.lastJsonPath) {
        log.info(`Config file changed: ${st.lastJsonPath} -> ${settings.jsonFile}`);
        st.lastJsonPath = settings.jsonFile;
        
        if (settings.fanExe) {
            this.launchFanControlConfig(settings.fanExe, settings.jsonFile, !!settings.bypassUac, ev.action);
        }
    }

    this.startPolling(ev.action);

    if (settings.fanExe) this.validateExe(settings.fanExe);
    if (settings.jsonFile) this.loadFans(settings.jsonFile);

    // 3. Update the display
    this.updateDisplayFromState(ev.action, settings, true);
    this.sendSelectionToPi(settings.jsonFile, settings.fanNick);
  }

  // ---------- POLLING ----------

  private startPolling(actionObj: any) {
    const contextId = actionObj.id;
    
    if (this.activeIntervals.has(contextId)) return;

    const timer = setInterval(() => {
      if (isShuttingDown()) return;
      // Pause polling if user is currently interacting with THIS dial (to prevent values jumping around)
      const st = this.dial(contextId);
      if (st.modeSelectionActive) return;
      if (st.pendingValue !== null) return;      
      if (st.pendingCurveIndex !== null) return; 

      const currentSettings = this.currentSettings.get(contextId);
      if (!currentSettings || !currentSettings.jsonFile || !currentSettings.fanNick) return;

      try {
          this.updateDisplayFromState(actionObj, currentSettings, true);
      } catch (e) {
          log.warn("Error in polling loop:", e);
      }
    }, 2000); 

    this.activeIntervals.set(contextId, timer);
  }

  private stopPolling(contextId: string) {
    const timer = this.activeIntervals.get(contextId);
    if (timer) {
      clearInterval(timer);
      this.activeIntervals.delete(contextId);
    }
  }

  /**
   * Central function to update the Stream Deck display.
   */
  private updateDisplayFromState(
    actionObj: any,
    settings: FanSettings,
    updateSettingsIfChanged: boolean
  ) {
    const modeSetting: ControlMode = settings.mode ?? "AUTO";
    const activeJsonPath = settings.jsonFile;

    const stateFromFile =
      activeJsonPath && settings.fanNick
        ? this.readFanStateFromJson(activeJsonPath, settings.fanNick)
        : null;

    const state: FanState = stateFromFile ?? {
        mode: modeSetting,
        value: 0,
        curveName: "None",
        availableCurves: []
    };

    const { mode, value, curveName } = state;
    
    const st = this.dial(actionObj.id);
    let displayTitle = this.buildTitle(settings.fanNick);
    
    if (st.modeSelectionActive) {
        displayTitle = "SELECT MODE";
    }

    this.safe(actionObj.setTitle(displayTitle), "setTitle");

    const payload = this.buildFeedbackPayload(st, displayTitle, mode, value, curveName);
    
    if (typeof actionObj.setFeedback === 'function') {
        this.safe(actionObj.setFeedback(payload), "setFeedback");
    }

    const hasError = this.isTaskMissing || this.isVbsMissing || this.isAdminVbsMissing;

    if (!st.modeSelectionActive && !hasError && updateSettingsIfChanged && settings.mode !== mode) {
      log.info(`Mode change detected in file: ${settings.mode} -> ${mode}`);
      
      const newSettings = { ...settings, mode };
      this.safe(actionObj.setSettings(newSettings), "setSettings");
      this.currentSettings.set(actionObj.id, newSettings);
    }
  }

  // ---------- DIAL EVENTS ----------

  override onDialDown(ev: DialDownEvent<FanSettings>): void {
    if (isShuttingDown()) return;
    const actionObj = ev.action;
    const settings = ev.payload.settings; 
    const st = this.dial(actionObj.id);
    
    if (this.isTaskMissing || this.isVbsMissing || this.isAdminVbsMissing) {
        this.safe(actionObj.showAlert(), "showAlert");
        return;
    }

    // A) Confirm selection (if mode selection is active)
    if (st.modeSelectionActive) {
      this.clearSelectModeTimeout(st); 

      const targetMode = st.pendingMode;
      const currentMode: ControlMode = settings.mode ?? "AUTO";

      // Validation for Software/Curve mode
      if (targetMode === "SOFT") {
          const state = this.readFanStateFromJson(settings.jsonFile, settings.fanNick);
          if (!state || state.availableCurves.length === 0) {
              st.modeSelectionActive = false;
              this.safe(actionObj.showAlert(), "showAlert");
              this.updateDisplayFromState(actionObj, settings, false);
              return;
          }
      }

      if (targetMode === currentMode || !settings.jsonFile || !settings.fanNick) {
        st.modeSelectionActive = false;
        this.updateDisplayFromState(actionObj, settings, false);
        return;
      }
      
      const result = this.setFanModeInJson(settings.jsonFile, settings.fanNick, targetMode);

      if (!result) {
        st.modeSelectionActive = false;
        this.safe(actionObj.showAlert(), "showAlert"); 
        this.updateDisplayFromState(actionObj, settings, false);
        return;
      }

      const newMode = result.mode;
      const newSettings = { ...settings, mode: newMode };
      
      this.safe(actionObj.setSettings(newSettings), "setSettings");
      this.currentSettings.set(actionObj.id, newSettings);

      st.modeSelectionActive = false; 
      
      const exePath = settings.fanExe;
      const jsonPath = settings.jsonFile;
      const bypassUac = !!settings.bypassUac;

      this.launchFanControlConfig(exePath, jsonPath, bypassUac, actionObj);
      
      this.updateDisplayFromState(actionObj, newSettings, false);
      return;
    }

    // B) Start mode selection
    // A rotation that is still pending is written first, otherwise it would be lost.
    if (st.pendingValueTimer) {
        clearTimeout(st.pendingValueTimer);
        st.pendingValueTimer = null;
        this.executePendingWrite(st);
    }
    st.modeSelectionActive = true;
    st.pendingMode = settings.mode ?? "AUTO";
    
    this.startSelectModeTimeout(actionObj, actionObj.id); 
    this.updateDisplayFromState(actionObj, settings, false);
  }

  override onDialRotate(ev: DialRotateEvent<FanSettings>): void {
    if (isShuttingDown()) return;
    if (this.isTaskMissing || this.isVbsMissing || this.isAdminVbsMissing) return;

    const actionObj = ev.action;
    const settings = ev.payload.settings;
    const ticks = ev.payload.ticks ?? 0;
    const st = this.dial(actionObj.id);

    if (ticks === 0) return;

    // A) Cycle through modes
    if (st.modeSelectionActive) {
      this.cyclePendingMode(st, ticks);
      this.startSelectModeTimeout(actionObj, actionObj.id); 
      this.updateDisplayFromState(actionObj, settings, false);
      return;
    }

    // B) Normal operation (change value)
    if (!settings.jsonFile || !settings.fanNick) return;

    const currentState = this.readFanStateFromJson(settings.jsonFile, settings.fanNick);
    if (!currentState) return;

    // AUTO
    if (currentState.mode === "AUTO") {
        return;
    }

    // MAN
    if (currentState.mode === "MAN") {
        let baseValue: number;
        if (st.pendingValue !== null) {
            baseValue = st.pendingValue;
        } else {
            baseValue = currentState.value;
        }

        let newValue = baseValue + ticks;
        if (newValue < 0) newValue = 0;
        if (newValue > 100) newValue = 100;

        st.pendingValue = newValue;
        st.pendingJsonPath = settings.jsonFile;
        st.pendingFanNick = settings.fanNick;
        st.pendingFanExe = settings.fanExe ?? null;
        st.pendingBypassUac = !!settings.bypassUac;
        st.pendingCurveIndex = null; 

        const displayTitle = this.buildTitle(settings.fanNick);
        this.safe(actionObj.setTitle(displayTitle), "setTitle");
        
        const feedback = this.buildFeedbackPayload(st, displayTitle, "MAN", newValue, "");
        if (typeof (actionObj as any).setFeedback === 'function') {
            this.safe((actionObj as any).setFeedback(feedback), "setFeedback");
        }
        
        this.triggerDebounceWrite(st, actionObj);
        return;
    }

    // SOFT
    if (currentState.mode === "SOFT") {
        const curves = currentState.availableCurves;
        if (curves.length === 0) return;

        let currentIndex = curves.indexOf(currentState.curveName);
        if (st.pendingCurveIndex !== null) {
            currentIndex = st.pendingCurveIndex;
        }
        if (currentIndex === -1) currentIndex = 0;

        let newIndex = currentIndex + ticks;
        if (newIndex < 0) newIndex = curves.length - 1;
        if (newIndex >= curves.length) newIndex = 0;

        st.pendingCurveIndex = newIndex;
        st.pendingJsonPath = settings.jsonFile;
        st.pendingFanNick = settings.fanNick;
        st.pendingFanExe = settings.fanExe ?? null;
        st.pendingBypassUac = !!settings.bypassUac;
        st.pendingValue = null;

        const newCurveName = curves[newIndex];
        const displayTitle = this.buildTitle(settings.fanNick);
        this.safe(actionObj.setTitle(displayTitle), "setTitle");

        const feedback = this.buildFeedbackPayload(st, displayTitle, "SOFT", 0, newCurveName);
        if (typeof (actionObj as any).setFeedback === 'function') {
            this.safe((actionObj as any).setFeedback(feedback), "setFeedback");
        }

        this.triggerDebounceWrite(st, actionObj);
        return;
    }
  }

  // --- Helper: Cycle through available modes ---
  private cyclePendingMode(st: DialState, ticks: number) {
      const modes: ControlMode[] = ["AUTO", "MAN", "SOFT"];
      let idx = modes.indexOf(st.pendingMode);
      if (idx === -1) idx = 0;
      
      if (ticks > 0) {
          idx++;
          if (idx >= modes.length) idx = 0;
      } else {
          idx--;
          if (idx < 0) idx = modes.length - 1;
      }
      st.pendingMode = modes[idx];
  }

  // --- Helper: Debounce write operations ---
  private triggerDebounceWrite(st: DialState, actionObj?: any) {
      if (st.pendingValueTimer) clearTimeout(st.pendingValueTimer);
      st.pendingAction = actionObj ?? null;

      st.pendingValueTimer = setTimeout(() => {
          st.pendingValueTimer = null;
          try {
              this.executePendingWrite(st);
          } catch (err) {
              log.error("executePendingWrite error", err);
          }
      }, 1200);
  }

  private executePendingWrite(st: DialState) {
      // No more file writes / FanControl restarts while Windows is shutting down
      if (isShuttingDown()) return;
      const jsonPath = st.pendingJsonPath;
      const fanNick = st.pendingFanNick;
      const exePath = st.pendingFanExe;
      const bypassUac = st.pendingBypassUac;
      const actionObj = st.pendingAction;

      if (!jsonPath || !fanNick) {
          this.clearPendingValue(st);
          return;
      }

      if (st.pendingValue !== null) {
          const result = this.setManualValueInJson(jsonPath, fanNick, st.pendingValue);
          st.pendingValue = null;
          
          if (result) {
             this.launchFanControlConfig(exePath ?? undefined, jsonPath, bypassUac, actionObj);
          }
      }
      else if (st.pendingCurveIndex !== null) {
          const state = this.readFanStateFromJson(jsonPath, fanNick);
          if (state && state.availableCurves.length > 0) {
              let idx = st.pendingCurveIndex;
              if (idx >= state.availableCurves.length) idx = 0;
              
              const curveName = state.availableCurves[idx];
              const result = this.setSoftwareCurveInJson(jsonPath, fanNick, curveName);
              
              if (result) {
                  this.launchFanControlConfig(exePath ?? undefined, jsonPath, bypassUac, actionObj);
              }
          }
          st.pendingCurveIndex = null;
      }
      this.clearPendingValue(st);
  }

  // ---------- VISUAL HELPERS (SVG) ----------

  private generatePanelImage(fanName: string, modeLabel: string, valueText: string, isSelectMode: boolean, isManualMode: boolean, errorType: "NONE" | "TASK" | "FILE" | "BOTH" = "NONE"): string {
    // Define colors
    const BLUE_COLOR = "#3984E9"; 
    // const BLACK_COLOR = "#000000";
    const BLACK_COLOR = "none";
    const RED_COLOR = "#aa0000"; 
    const WHITE_COLOR = "#ffffff";
    const GREY_COLOR = "#cccccc"; 
    
    const isError = (errorType !== "NONE");

    // Select background color based on state
    let bgColor = BLACK_COLOR;
    if (isError) bgColor = RED_COLOR;
    else if (isSelectMode) bgColor = BLUE_COLOR;
    
    const titleColor = WHITE_COLOR;
    const modeLabelColor = (isSelectMode || isError) ? WHITE_COLOR : BLUE_COLOR; 
    const valueColor = WHITE_COLOR;

    const valueNum = parseInt(valueText.replace('%', '').trim(), 10); 
    const percentage = isNaN(valueNum) ? 0 : valueNum;
    const barWidth = 180 * (percentage / 100);

    let displayFanName = fanName;
    if (displayFanName.length > 15) {
        displayFanName = displayFanName.substring(0, 15) + "...";
    }

    let titleSvg = "";
    if (isError) {
        titleSvg = `<text x="5" y="20" font-family="sans-serif" font-size="15" font-weight="600" fill="${WHITE_COLOR}" text-anchor="start">ERROR</text>`;
    } else if (isSelectMode) {
        titleSvg = `<text x="5" y="20" font-family="sans-serif" font-size="15" font-weight="600" fill="${WHITE_COLOR}" text-anchor="start">SELECT MODE</text>`;
    } else {
        titleSvg = `
        <text x="5" y="20" font-family="sans-serif" font-size="15" font-weight="600" fill="${titleColor}" text-anchor="start">
            ${xml(displayFanName)} (<tspan fill="${modeLabelColor}">${xml(modeLabel)}</tspan>)
        </text>`;
    }

    let extraLabelSvg = "";
    let valueY = 60; 
    let valueFontSize = 22; 
    let valueX = 65; 
    let mainTextElement = ""; 

    if (modeLabel === "CURVE" && !isSelectMode && !isError) {
        extraLabelSvg = `<text x="65" y="40" font-family="sans-serif" font-size="14" font-weight="normal" fill="${GREY_COLOR}" text-anchor="start">Selected curve:</text>`;
        valueY = 62;
    }
    
    if (isError) {
        // Configure error display text
        let errorTitle = "";
        
        valueFontSize = 14; 
        valueX = 10;        
        valueY = 70;

        if (errorType === "BOTH") {
            errorTitle = "Config Issues:";
            mainTextElement = `
            <text x="${valueX}" y="65" font-family="sans-serif" font-size="${valueFontSize}" font-weight="bold" fill="${valueColor}" text-anchor="start">- Missing Task</text>
            <text x="${valueX}" y="82" font-family="sans-serif" font-size="${valueFontSize}" font-weight="bold" fill="${valueColor}" text-anchor="start">- Missing Scripts</text>
            `;
        } 
        else {
            // Single error cases
            if (errorType === "FILE") {
                errorTitle = "Missing Script:";
                // Logic moved to buildFeedbackPayload/here: We display specific file if possible
                // valueText is passed in as the specific file name in buildFeedbackPayload
                
                // If valueText is generic, we try to detect specific file via class props (if available)
                // However, since this is a pure function call, rely on valueText being correct.
            } else {
                errorTitle = "Missing Task:";
                valueText = "FanControlRestart";
            }
            mainTextElement = `<text x="${valueX}" y="${valueY}" font-family="sans-serif" font-size="${valueFontSize}" font-weight="bold" fill="${valueColor}" text-anchor="start">${xml(valueText)}</text>`;
        }

        extraLabelSvg = `<text x="5" y="45" font-family="sans-serif" font-size="12" font-weight="normal" fill="${WHITE_COLOR}" text-anchor="start">${errorTitle}</text>`;
    } else {
        // Standard case (no error)
        mainTextElement = `<text x="${valueX}" y="${valueY}" font-family="sans-serif" font-size="${valueFontSize}" font-weight="bold" fill="${valueColor}" text-anchor="start">${xml(valueText)}</text>`;
    }

    const svg = `
    <svg width="200" height="100" viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="200" height="100" fill="${bgColor}" />
        
        ${titleSvg}
        
        ${extraLabelSvg}
        
        ${mainTextElement}
        
        ${(!isSelectMode && isManualMode && !isError) ? `
        <rect x="9" y="76" width="182" height="10" rx="5" ry="5" fill="none" stroke="#ffffff" stroke-width="1" />
        <rect x="10" y="77" width="180" height="8" fill="#333333" rx="4" ry="4"/>
        <rect x="10" y="77" width="${barWidth}" height="8" fill="${BLUE_COLOR}" rx="4" ry="4"/>
        ` : ''}
    </svg>`;

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  private buildFeedbackPayload(st: DialState, title: string, mode: ControlMode, value: number, curveName: string = "") {
    let errorType: "NONE" | "TASK" | "FILE" | "BOTH" = "NONE";
    let errorText = "";

    // Check if any of the required files are missing
    const anyFileMissing = this.isVbsMissing || this.isAdminVbsMissing;

    if (anyFileMissing && this.isTaskMissing) errorType = "BOTH";
    else if (anyFileMissing) {
        errorType = "FILE";
        // Determine specific error text
        if (this.isVbsMissing && this.isAdminVbsMissing) {
            errorText = "Both .vbs files";
        } else if (this.isAdminVbsMissing) {
            errorText = "admin_action.vbs";
        } else {
            errorText = "silent_restart.vbs";
        }
    }
    else if (this.isTaskMissing) errorType = "TASK";

    if (errorType !== "NONE") {
        const image = this.generatePanelImage("ERROR", "", errorText, false, false, errorType);
        return {
            full_display: image,
            // If an error exists, send a transparent icon to hide the default fan image
            icon: TRANSPARENT_ICON, 
            indicator: { value: 0, bar_fill_c: "#00000000", bar_bg_c: "#00000000", bar_border_c: "#00000000" }
        };
    }

    let displayValue = "";
    let barValue = 0;
    let barFill = "#00000000";
    let barBg = "#00000000";

    if (mode === "MAN") {
        const v = Math.max(0, Math.min(100, value));
        displayValue = `${v}%`;
        barValue = v;
    } else if (mode === "AUTO") {
        displayValue = "AUTO";
    } else if (mode === "SOFT") {
        displayValue = curveName || "Curve";
    }

    let modeLabel: string = mode; 
    if (mode === "SOFT") modeLabel = "CURVE"; 

    if (st.modeSelectionActive) {
       if (st.pendingMode === "MAN") displayValue = "MANUAL";
       else if (st.pendingMode === "AUTO") displayValue = "AUTO";
       else if (st.pendingMode === "SOFT") displayValue = "CURVE"; 
       
       title = "SELECT MODE";
    }

    const isManual = (mode === "MAN");
    const image = this.generatePanelImage(title, modeLabel, displayValue, st.modeSelectionActive, isManual, "NONE");

    return {
        full_display: image, 
        icon: null, 
        indicator: { 
            value: barValue,
            bar_fill_c: barFill,
            bar_bg_c: barBg,
            bar_border_c: barBg
        }
    };
  }

  private buildTitle(fanNick: string | undefined): string {
    return fanNick ?? "(no fan)";
  }

  // ---------- JSON / SYSTEM LOGIC ----------

  private readFanStateFromJson(
    jsonPath: string | undefined,
    fanNick: string | undefined,
  ): FanState | null {
    if (!jsonPath || !fanNick) return null;

    try {
      const data = this.readJsonCached(jsonPath);
      if (!data) return null;
      const controls = data?.FanControl?.Controls as any[];
      const fanCurves = data?.FanControl?.FanCurves as any[];

      let availableCurves: string[] = [];
      if (Array.isArray(fanCurves)) {
          availableCurves = fanCurves.filter(c => c.Name && !c.IsHidden).map(c => c.Name);
      }

      if (!Array.isArray(controls)) return null;

      const ctrl = controls.find((c) => c.NickName === fanNick && !c.IsHidden);
      if (!ctrl) return null;

      // Detect current mode from JSON data
      let mode: ControlMode = "AUTO";
      if (ctrl.Enable === false) {
          mode = "AUTO";
      } else if (ctrl.Enable === true) {
          if (ctrl.ManualControl === true) {
              mode = "MAN";
          } else {
              mode = "SOFT";
          }
      }

      let value = Number(ctrl.ManualControlValue);
      if (!Number.isFinite(value)) value = 0;

      let curveName = "Unknown";
      if (ctrl.SelectedFanCurve && ctrl.SelectedFanCurve.Name) {
          curveName = ctrl.SelectedFanCurve.Name;
      }

      return { mode, value, curveName, availableCurves };

    } catch (err) {
      log.error("Read JSON error", err);
      return null;
    }
  }

  /**
   * Reads the FanControl JSON only when mtime/size changed.
   * FanControl rewrites its config when it exits (i.e. at shutdown too) – a
   * half-written file is remembered as "invalid" exactly once instead of being
   * logged with a stack trace every 2 s.
   */
  private readJsonCached(jsonPath: string): any | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(jsonPath);
    } catch {
      this.jsonCache.delete(jsonPath);
      return null;
    }

    const cached = this.jsonCache.get(jsonPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.data;
    }

    let data: any | null = null;
    try {
      data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    } catch (err) {
      if (!isShuttingDown()) log.warn(`JSON not readable (maybe being written): ${jsonPath}`, (err as any)?.message ?? err);
      data = null;
    }
    this.jsonCache.set(jsonPath, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  }

  private setFanModeInJson(
    jsonPath: string,
    fanNick: string,
    targetMode: ControlMode,
  ): FanState | null {
    if (!fs.existsSync(jsonPath)) return null;

    try {
      const contents = fs.readFileSync(jsonPath, "utf-8");
      const data = JSON.parse(contents) as any;
      const controls = data?.FanControl?.Controls as any[];
      const fanCurves = data?.FanControl?.FanCurves as any[];

      let availableCurves: string[] = [];
      if (Array.isArray(fanCurves)) {
          availableCurves = fanCurves.filter(c => c.Name && !c.IsHidden).map(c => c.Name);
      }

      if (!Array.isArray(controls)) return null;
      const ctrl = controls.find((c) => c.NickName === fanNick && !c.IsHidden);
      if (!ctrl) return null;

      if (targetMode === "AUTO") {
          ctrl.Enable = false;
          ctrl.ManualControl = false;
      } 
      else if (targetMode === "MAN") {
          ctrl.Enable = true;
          ctrl.ManualControl = true;
      } 
      else if (targetMode === "SOFT") {
          if (availableCurves.length === 0) return null;

          ctrl.Enable = true;
          ctrl.ManualControl = false;
          
          if (!ctrl.SelectedFanCurve || !ctrl.SelectedFanCurve.Name) {
              ctrl.SelectedFanCurve = { "Name": availableCurves[0] };
          }
      }

      let value = Number(ctrl.ManualControlValue);
      if (!Number.isFinite(value)) value = 0;
      
      let currentCurve = "None";
      if (ctrl.SelectedFanCurve?.Name) currentCurve = ctrl.SelectedFanCurve.Name;

      writeJsonSafe(jsonPath, data);
      this.jsonCache.delete(jsonPath);
      
      return { mode: targetMode, value, curveName: currentCurve, availableCurves };

    } catch (err: any) {
      log.error("setFanModeInJson error", err);
      return null;
    }
  }

  private setManualValueInJson(
    jsonPath: string,
    fanNick: string,
    value: number,
  ): FanState | null {
    if (!fs.existsSync(jsonPath)) return null;

    try {
      const contents = fs.readFileSync(jsonPath, "utf-8");
      const data = JSON.parse(contents) as any;
      const controls = data?.FanControl?.Controls as any[];

      if (!Array.isArray(controls)) return null;
      const ctrl = controls.find((c) => c.NickName === fanNick && !c.IsHidden);
      if (!ctrl) return null;

      ctrl.Enable = true;
      ctrl.ManualControl = true;

      let v = Number(value);
      if (v < 0) v = 0; if (v > 100) v = 100;
      ctrl.ManualControlValue = v;

      writeJsonSafe(jsonPath, data);
      this.jsonCache.delete(jsonPath);
      return { mode: "MAN", value: v, curveName: "", availableCurves: [] };
    } catch (err) {
      log.error("JSON write error", err);
      return null;
    }
  }

  private setSoftwareCurveInJson(
    jsonPath: string,
    fanNick: string,
    curveName: string,
  ): FanState | null {
    if (!fs.existsSync(jsonPath)) return null;

    try {
      const contents = fs.readFileSync(jsonPath, "utf-8");
      const data = JSON.parse(contents) as any;
      const controls = data?.FanControl?.Controls as any[];

      if (!Array.isArray(controls)) return null;
      const ctrl = controls.find((c) => c.NickName === fanNick && !c.IsHidden);
      if (!ctrl) return null;

      ctrl.Enable = true;
      ctrl.ManualControl = false;
      ctrl.SelectedFanCurve = { "Name": curveName };

      writeJsonSafe(jsonPath, data);
      this.jsonCache.delete(jsonPath);
      return { mode: "SOFT", value: 0, curveName: curveName, availableCurves: [] };
    } catch (err) {
      log.error("JSON write error", err);
      return null;
    }
  }

  // --- STARTUP LOGIC (UAC / Task Scheduler) ---
  
  /**
   * Check if both the Windows Task and BOTH VBS helper files exist.
   */
  private async performUacChecks(settings: FanSettings): Promise<void> {
      if (isShuttingDown()) return;
      // 1. Task Check
      try {
          await execAsync('schtasks /query /tn "FanControlRestart" /fo CSV /nh', { windowsHide: true, timeout: 5000 });
          this.isTaskMissing = false;
      } catch (e) {
          this.isTaskMissing = true;
      }

      // 2. VBS File Checks
      if (settings.fanExe) {
          const exeDir = path.dirname(settings.fanExe);
          
          // Check silent_restart.vbs
          const vbsPath = path.join(exeDir, "silent_restart.vbs");
          this.isVbsMissing = !fs.existsSync(vbsPath);

          // Check admin_action.vbs (NEU)
          const adminVbsPath = path.join(exeDir, "admin_action.vbs");
          this.isAdminVbsMissing = !fs.existsSync(adminVbsPath);

      } else {
          this.isVbsMissing = true; 
          this.isAdminVbsMissing = true;
      }
  }

  private sendUacStatusToPi() {
      this.sendToPi({ 
          command: "uacCheck", 
          taskExists: !this.isTaskMissing, 
          vbsExists: !this.isVbsMissing,
          adminVbsExists: !this.isAdminVbsMissing // NEU
      });
  }

  private launchFanControlConfig(
    exePath: string | undefined | null, 
    jsonPath: string | undefined | null, 
    bypassUac: boolean,
    actionObj?: any
  ): void {
    // Starting processes during Windows shutdown fails (0xC0000142 dialogs)
    if (isShuttingDown()) {
        log.info("Shutdown in progress – FanControl restart skipped");
        return;
    }
    if (!exePath || !fs.existsSync(exePath)) return;
    if (!jsonPath) return;

    const exeDir = path.dirname(exePath);

    try {
        const configFileName = path.basename(jsonPath); 
        const trackerFile = path.join(exeDir, "active_config.txt");
        
        fs.writeFileSync(trackerFile, configFileName, "utf-8");
        log.info(`Active config written to: ${trackerFile} -> ${configFileName}`);
    } catch (e) {
        log.error("Could not write active_config.txt", e);
    }

    // A) Task Scheduler (via Checkbox)
    if (bypassUac) {
        // Run VBS only if ALL checks passed
        const safeToRun = !this.isTaskMissing && !this.isVbsMissing && !this.isAdminVbsMissing;

        if (safeToRun) {
            this.triggerSilentRestart(exeDir);
        } else if (!this.isTaskMissing) {
            // Fallback: Trigger Task only (might show a popup, but better than failing)
             this.triggerTaskSchedulerRestart();
        }
        return;
    }

    // B) Fallback: Start EXE directly (will trigger UAC prompt)
    log.info(`Running EXE (UAC): ${exePath}`);
    try {
      const command = `"${exePath}" -c "${jsonPath}"`;
      const child = spawn(command, {
        shell: true, cwd: exeDir, detached: true, windowsHide: true, stdio: "ignore",
      });
      child.on("error", (err) => log.error("Launch error", err));
      child.unref();
    } catch (err) { log.error("Launch Exception", err); }
  }

  private triggerTaskSchedulerRestart(): void {
    log.info("Triggering Task 'FanControlRestart'...");
    try {
        const child = spawn('schtasks', ['/run', '/tn', 'FanControlRestart'], {
            detached: true, windowsHide: true, stdio: "ignore"
        });
        // Without an 'error' listener a failed spawn throws an uncaught exception!
        child.on("error", (err) => log.error("schtasks launch error", err));
        child.unref();
    } catch (err) { log.error("schtasks spawn exception", err); }
  }

  private triggerSilentRestart(cwd: string): void {
      log.info("Triggering silent_restart.vbs...");
      // wscript "path/to/silent_restart.vbs"
      // Since we set cwd, the filename is sufficient
      try {
          const child = spawn('wscript', ['silent_restart.vbs'], {
              cwd,
              detached: true,
              windowsHide: true,
              stdio: "ignore"
          });
          child.on('error', (err) => { log.error("VBS launch error", err); });
          child.unref();
      } catch (err) { log.error("VBS spawn exception", err); }
  }

  // ---------- COMMUNICATION & HELPERS ----------

  private validateExe(exePath: string): void {
    try {
      this.validateExeUnsafe(exePath);
    } catch (err) {
      log.error("validateExe error", err);
      this.sendToPi({ command: "exeResult", error: "config_folder_missing" });
    }
  }

  private validateExeUnsafe(exePath: string): void {
    if (path.basename(exePath).toLowerCase() !== "fancontrol.exe") {
      this.sendToPi({ command: "exeResult", error: "wrong_exe" });
      return;
    }
    const exeDir = path.dirname(exePath);
    const configDir = path.join(exeDir, "Configurations");

    if (!fs.existsSync(configDir)) {
      this.sendToPi({ command: "exeResult", error: "config_folder_missing" });
      return;
    }
    const jsonFiles = fs.readdirSync(configDir).filter((f) => f.toLowerCase().endsWith(".json"));
    if (jsonFiles.length === 0) {
      this.sendToPi({ command: "exeResult", error: "no_json" });
      return;
    }
    const fullPaths = jsonFiles.map((f) => path.join(configDir, f));
    this.sendToPi({ command: "exeResult", error: null, exePath, files: fullPaths });
  }

  private loadFans(jsonPath: string): void {
    if (!fs.existsSync(jsonPath)) {
      this.sendToPi({ command: "fanList", fans: [], error: "json_missing" });
      return;
    }
    try {
      const contents = fs.readFileSync(jsonPath, "utf-8");
      const data = JSON.parse(contents) as any;
      const controls = data?.FanControl?.Controls as any[];
      let fans: string[] = [];
      if (Array.isArray(controls)) {
        fans = controls.filter((c) => c.NickName && !c.IsHidden).map((c) => String(c.NickName));
      }
      if (fans.length === 0) {
         const sensors = data?.FanControl?.FanSensors as any[];
         if(Array.isArray(sensors)) {
             fans = sensors.filter(s => s.NickName).map((s) => String(s.NickName));
         }
      }
      this.sendToPi({ command: "fanList", fans });
    } catch (err) {
      this.sendToPi({ command: "fanList", fans: [], error: "json_read_error" });
    }
  }

  private sendSelectionToPi(jsonFile: string | undefined, fanNick: string | undefined): void {
    this.sendToPi({ command: "selection", jsonFile: jsonFile ?? null, fanNick: fanNick ?? null });
  }

  private sendToPi(message: PiMessage | JsonValue): void {
    try {
      const ui = streamDeck.ui.current as any;
      if (ui && typeof ui.sendToPropertyInspector === "function") {
        this.safe(ui.sendToPropertyInspector(message), "sendToPropertyInspector");
      }
    } catch (err) { log.error("Error sending to PI", err); }
  }

  private clearPendingValue(st: DialState): void {
    if (st.pendingValueTimer) {
      clearTimeout(st.pendingValueTimer);
      st.pendingValueTimer = null;
    }
    st.pendingValue = null;
    st.pendingJsonPath = null;
    st.pendingFanNick = null;
    st.pendingFanExe = null;
    st.pendingCurveIndex = null;
    st.pendingAction = null;
  }
}
// src/actions/fan-control-encoder.ts
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
    };

interface FanState {
    mode: ControlMode;
    value: number;          
    curveName: string;      
    availableCurves: string[]; 
}

const log = streamDeck.logger.createScope("FanControlEncoder");

@action({ UUID: "com.holgermilz.myfancontrol.increment" })
export class FanControlEncoder extends SingletonAction<FanSettings> {
  // --- STATE VARIABLES ---
  private modeSelectionActive = false;
  private pendingMode: ControlMode = "AUTO";
  
  // ERROR FLAGS
  private isTaskMissing = false;
  private isVbsMissing = false;

  // Debounce timers and pending values to prevent flooding the backend
  private pendingValueTimer: NodeJS.Timeout | null = null;
  private pendingValue: number | null = null; 
  private pendingCurveIndex: number | null = null; 
  private pendingJsonPath: string | null = null;
  private pendingFanNick: string | null = null;
  private pendingFanExe: string | null = null;
  private pendingBypassUac: boolean = false;
  
  // Timeout for mode selection
  private selectModeTimeoutTimer: NodeJS.Timeout | null = null; 

  // Polling interval management
  private activeIntervals = new Map<string, NodeJS.Timeout>();
  
  // Global settings storage
  private currentSettings = new Map<string, FanSettings>();

  private lastFanNick: string | undefined;
  private lastJsonPath: string | undefined;

  // ---------- TIMEOUT HELPERS ----------
  
  private clearSelectModeTimeout(): void {
      if (this.selectModeTimeoutTimer) {
          clearTimeout(this.selectModeTimeoutTimer);
          this.selectModeTimeoutTimer = null;
      }
  }

  private startSelectModeTimeout(actionObj: any, context: string): void {
      this.clearSelectModeTimeout();
      
      this.selectModeTimeoutTimer = setTimeout(() => {
          log.info('Select mode timeout reached, reverting.');
          this.modeSelectionActive = false; 
          
          const settings = this.currentSettings.get(context);
          if (settings) {
              this.updateDisplayFromState(actionObj, settings, false);
          }
      }, 3000); 
  }

  // ---------- LIFECYCLE EVENTS ----------

  override onWillAppear(ev: WillAppearEvent<FanSettings>): void {
    const settings = (ev.payload.settings ?? {}) as FanSettings;
    this.currentSettings.set(ev.action.id, settings);

    this.modeSelectionActive = false;
    this.clearPendingValue();
    
    // Reset error flags on appearance
    this.isTaskMissing = false; 
    this.isVbsMissing = false;

    this.lastFanNick = settings.fanNick;
    this.lastJsonPath = settings.jsonFile;

    // Perform initial UAC/File checks asynchronously
    if (settings.bypassUac) {
        this.performUacChecks(settings).then(() => {
            this.updateDisplayFromState(ev.action, settings, false);
        });
    }

    this.updateDisplayFromState(ev.action, settings, true);

    if (settings.fanExe) this.validateExe(settings.fanExe);
    if (settings.jsonFile) this.loadFans(settings.jsonFile);
    this.sendSelectionToPi(settings.jsonFile, settings.fanNick);

    this.startPolling(ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent<FanSettings>): void {
    this.stopPolling(ev.action.id);
    this.currentSettings.delete(ev.action.id);
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
    const settings = (ev.payload.settings ?? {}) as FanSettings;
    this.currentSettings.set(ev.action.id, settings);
    
    this.modeSelectionActive = false;
    this.clearPendingValue();

    // 1. Perform UAC and File checks
    if (settings.bypassUac === true) {
        await this.performUacChecks(settings);
        this.sendUacStatusToPi();

        if (this.isTaskMissing || this.isVbsMissing) {
            ev.action.showAlert(); 
        }
    } else {
        this.isTaskMissing = false; 
        this.isVbsMissing = false;
        // Reset errors in Property Inspector
        this.sendToPi({ command: "uacCheck", taskExists: true, vbsExists: true });
    }

    // 2. Handle path changes and restart logic
    if (settings.jsonFile && settings.jsonFile !== this.lastJsonPath) {
        log.info(`Config file changed: ${this.lastJsonPath} -> ${settings.jsonFile}`);
        this.lastJsonPath = settings.jsonFile;
        
        if (settings.fanExe) {
            this.launchFanControlConfig(settings.fanExe, settings.jsonFile, !!settings.bypassUac, ev.action);
        }
    }

    if (settings.fanNick !== this.lastFanNick) {
        this.lastFanNick = settings.fanNick;
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
      // Pause polling if user is currently interacting (to prevent values jumping around)
      if (this.modeSelectionActive) return;
      if (this.pendingValue !== null) return;      
      if (this.pendingCurveIndex !== null) return; 

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
    
    let displayTitle = this.buildTitle(settings.fanNick);
    
    if (this.modeSelectionActive) {
        displayTitle = "SELECT MODE";
    }

    actionObj.setTitle(displayTitle);

    const payload = this.buildFeedbackPayload(displayTitle, mode, value, curveName);
    
    if (typeof actionObj.setFeedback === 'function') {
        actionObj.setFeedback(payload);
    }

    const hasError = this.isTaskMissing || this.isVbsMissing;

    if (!this.modeSelectionActive && !hasError && updateSettingsIfChanged && settings.mode !== mode) {
      log.info(`Mode change detected in file: ${settings.mode} -> ${mode}`);
      
      const newSettings = { ...settings, mode };
      actionObj.setSettings(newSettings);
      this.currentSettings.set(actionObj.id, newSettings);
    }
  }

  // ---------- DIAL EVENTS ----------

  override onDialDown(ev: DialDownEvent<FanSettings>): void {
    const actionObj = ev.action;
    const settings = ev.payload.settings; 
    
    if (this.isTaskMissing || this.isVbsMissing) {
        actionObj.showAlert();
        return;
    }

    // A) Confirm selection (if mode selection is active)
    if (this.modeSelectionActive) {
      this.clearSelectModeTimeout(); 

      const targetMode = this.pendingMode;
      const currentMode: ControlMode = settings.mode ?? "AUTO";

      // Validation for Software/Curve mode
      if (targetMode === "SOFT") {
          const state = this.readFanStateFromJson(settings.jsonFile, settings.fanNick);
          if (!state || state.availableCurves.length === 0) {
              this.modeSelectionActive = false;
              actionObj.showAlert();
              this.updateDisplayFromState(actionObj, settings, false);
              return;
          }
      }

      if (targetMode === currentMode || !settings.jsonFile || !settings.fanNick) {
        this.modeSelectionActive = false;
        this.updateDisplayFromState(actionObj, settings, false);
        return;
      }
      
      const result = this.setFanModeInJson(settings.jsonFile, settings.fanNick, targetMode);

      if (!result) {
        this.modeSelectionActive = false;
        actionObj.showAlert(); 
        this.updateDisplayFromState(actionObj, settings, false);
        return;
      }

      const newMode = result.mode;
      const newSettings = { ...settings, mode: newMode };
      
      actionObj.setSettings(newSettings);
      this.currentSettings.set(actionObj.id, newSettings);

      this.modeSelectionActive = false; 
      
      const exePath = settings.fanExe;
      const jsonPath = settings.jsonFile;
      const bypassUac = !!settings.bypassUac;

      this.launchFanControlConfig(exePath, jsonPath, bypassUac, actionObj);
      
      this.updateDisplayFromState(actionObj, newSettings, false);
      return;
    }

    // B) Start mode selection
    this.modeSelectionActive = true;
    this.pendingMode = settings.mode ?? "AUTO";
    
    this.startSelectModeTimeout(actionObj, actionObj.id); 
    this.updateDisplayFromState(actionObj, settings, false);
    this.clearPendingValue();
  }

  override onDialRotate(ev: DialRotateEvent<FanSettings>): void {
    if (this.isTaskMissing || this.isVbsMissing) return;

    const actionObj = ev.action;
    const settings = ev.payload.settings;
    const ticks = ev.payload.ticks ?? 0;

    if (ticks === 0) return;

    // A) Cycle through modes
    if (this.modeSelectionActive) {
      this.cyclePendingMode(ticks);
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
        if (this.pendingValue !== null) {
            baseValue = this.pendingValue;
        } else {
            baseValue = currentState.value;
        }

        let newValue = baseValue + ticks;
        if (newValue < 0) newValue = 0;
        if (newValue > 100) newValue = 100;

        this.pendingValue = newValue;
        this.pendingJsonPath = settings.jsonFile;
        this.pendingFanNick = settings.fanNick;
        this.pendingFanExe = settings.fanExe ?? null;
        this.pendingBypassUac = !!settings.bypassUac;
        this.pendingCurveIndex = null; 

        const displayTitle = this.buildTitle(settings.fanNick);
        actionObj.setTitle(displayTitle);
        
        const feedback = this.buildFeedbackPayload(displayTitle, "MAN", newValue, "");
        if (typeof (actionObj as any).setFeedback === 'function') {
            (actionObj as any).setFeedback(feedback);
        }
        
        this.triggerDebounceWrite(actionObj);
        return;
    }

    // SOFT
    if (currentState.mode === "SOFT") {
        const curves = currentState.availableCurves;
        if (curves.length === 0) return;

        let currentIndex = curves.indexOf(currentState.curveName);
        if (this.pendingCurveIndex !== null) {
            currentIndex = this.pendingCurveIndex;
        }
        if (currentIndex === -1) currentIndex = 0;

        let newIndex = currentIndex + ticks;
        if (newIndex < 0) newIndex = curves.length - 1;
        if (newIndex >= curves.length) newIndex = 0;

        this.pendingCurveIndex = newIndex;
        this.pendingJsonPath = settings.jsonFile;
        this.pendingFanNick = settings.fanNick;
        this.pendingFanExe = settings.fanExe ?? null;
        this.pendingBypassUac = !!settings.bypassUac;
        this.pendingValue = null;

        const newCurveName = curves[newIndex];
        const displayTitle = this.buildTitle(settings.fanNick);
        actionObj.setTitle(displayTitle);

        const feedback = this.buildFeedbackPayload(displayTitle, "SOFT", 0, newCurveName);
        if (typeof (actionObj as any).setFeedback === 'function') {
            (actionObj as any).setFeedback(feedback);
        }

        this.triggerDebounceWrite(actionObj);
        return;
    }
  }

  // --- Helper: Cycle through available modes ---
  private cyclePendingMode(ticks: number) {
      const modes: ControlMode[] = ["AUTO", "MAN", "SOFT"];
      let idx = modes.indexOf(this.pendingMode);
      if (idx === -1) idx = 0;
      
      if (ticks > 0) {
          idx++;
          if (idx >= modes.length) idx = 0;
      } else {
          idx--;
          if (idx < 0) idx = modes.length - 1;
      }
      this.pendingMode = modes[idx];
  }

  // --- Helper: Debounce write operations ---
  private triggerDebounceWrite(actionObj?: any) {
      if (this.pendingValueTimer) clearTimeout(this.pendingValueTimer);

      this.pendingValueTimer = setTimeout(() => {
          this.executePendingWrite(actionObj);
      }, 1200);
  }

  private executePendingWrite(actionObj?: any) {
      this.pendingValueTimer = null;
      const jsonPath = this.pendingJsonPath;
      const fanNick = this.pendingFanNick;
      const exePath = this.pendingFanExe;
      const bypassUac = this.pendingBypassUac;

      if (!jsonPath || !fanNick) return;

      if (this.pendingValue !== null) {
          const result = this.setManualValueInJson(jsonPath, fanNick, this.pendingValue);
          this.pendingValue = null;
          
          if (result) {
             this.launchFanControlConfig(exePath ?? undefined, jsonPath, bypassUac, actionObj);
          }
      }
      else if (this.pendingCurveIndex !== null) {
          const state = this.readFanStateFromJson(jsonPath, fanNick);
          if (state && state.availableCurves.length > 0) {
              let idx = this.pendingCurveIndex;
              if (idx >= state.availableCurves.length) idx = 0;
              
              const curveName = state.availableCurves[idx];
              const result = this.setSoftwareCurveInJson(jsonPath, fanNick, curveName);
              
              if (result) {
                  this.launchFanControlConfig(exePath ?? undefined, jsonPath, bypassUac, actionObj);
              }
          }
          this.pendingCurveIndex = null;
      }
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
            ${displayFanName} (<tspan fill="${modeLabelColor}">${modeLabel}</tspan>)
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
            // Use two separate text elements to ensure they are displayed one below the other
            mainTextElement = `
            <text x="${valueX}" y="65" font-family="sans-serif" font-size="${valueFontSize}" font-weight="bold" fill="${valueColor}" text-anchor="start">- Missing Task</text>
            <text x="${valueX}" y="82" font-family="sans-serif" font-size="${valueFontSize}" font-weight="bold" fill="${valueColor}" text-anchor="start">- Missing VBS</text>
            `;
        } 
        else {
            // Single error cases
            if (errorType === "FILE") {
                errorTitle = "Missing VBS File:";
                valueText = "silent_restart.vbs";
            } else {
                errorTitle = "Missing Task:";
                valueText = "FanControlRestart";
            }
            mainTextElement = `<text x="${valueX}" y="${valueY}" font-family="sans-serif" font-size="${valueFontSize}" font-weight="bold" fill="${valueColor}" text-anchor="start">${valueText}</text>`;
        }

        extraLabelSvg = `<text x="5" y="45" font-family="sans-serif" font-size="12" font-weight="normal" fill="${WHITE_COLOR}" text-anchor="start">${errorTitle}</text>`;
    } else {
        // Standard case (no error)
        mainTextElement = `<text x="${valueX}" y="${valueY}" font-family="sans-serif" font-size="${valueFontSize}" font-weight="bold" fill="${valueColor}" text-anchor="start">${valueText}</text>`;
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

  private buildFeedbackPayload(title: string, mode: ControlMode, value: number, curveName: string = "") {
    let errorType: "NONE" | "TASK" | "FILE" | "BOTH" = "NONE";

    if (this.isVbsMissing && this.isTaskMissing) errorType = "BOTH";
    else if (this.isVbsMissing) errorType = "FILE";
    else if (this.isTaskMissing) errorType = "TASK";

    if (errorType !== "NONE") {
        const image = this.generatePanelImage("ERROR", "", "ERR", false, false, errorType);
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

    if (this.modeSelectionActive) {
       if (this.pendingMode === "MAN") displayValue = "MANUAL";
       else if (this.pendingMode === "AUTO") displayValue = "AUTO";
       else if (this.pendingMode === "SOFT") displayValue = "CURVE"; 
       
       title = "SELECT MODE";
    }

    const isManual = (mode === "MAN");
    const image = this.generatePanelImage(title, modeLabel, displayValue, this.modeSelectionActive, isManual, "NONE");

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
    if (!fs.existsSync(jsonPath)) return null;

    try {
      const contents = fs.readFileSync(jsonPath, "utf-8");
      const data = JSON.parse(contents) as any;
      const controls = data?.Main?.Controls as any[];
      const fanCurves = data?.Main?.FanCurves as any[];

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

  private setFanModeInJson(
    jsonPath: string,
    fanNick: string,
    targetMode: ControlMode,
  ): FanState | null {
    if (!fs.existsSync(jsonPath)) return null;

    try {
      const contents = fs.readFileSync(jsonPath, "utf-8");
      const data = JSON.parse(contents) as any;
      const controls = data?.Main?.Controls as any[];
      const fanCurves = data?.Main?.FanCurves as any[];

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

      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf-8");
      
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
      const controls = data?.Main?.Controls as any[];

      if (!Array.isArray(controls)) return null;
      const ctrl = controls.find((c) => c.NickName === fanNick && !c.IsHidden);
      if (!ctrl) return null;

      ctrl.Enable = true;
      ctrl.ManualControl = true;

      let v = Number(value);
      if (v < 0) v = 0; if (v > 100) v = 100;
      ctrl.ManualControlValue = v;

      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf-8");
      return { mode: "MAN", value: v, curveName: "", availableCurves: [] };
    } catch (err) { return null; }
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
      const controls = data?.Main?.Controls as any[];

      if (!Array.isArray(controls)) return null;
      const ctrl = controls.find((c) => c.NickName === fanNick && !c.IsHidden);
      if (!ctrl) return null;

      ctrl.Enable = true;
      ctrl.ManualControl = false;
      ctrl.SelectedFanCurve = { "Name": curveName };

      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf-8");
      return { mode: "SOFT", value: 0, curveName: curveName, availableCurves: [] };
    } catch (err) { return null; }
  }

  // --- STARTUP LOGIC (UAC / Task Scheduler) ---
  
  /**
   * Check if both the Windows Task and the VBS helper file exist.
   */
  private async performUacChecks(settings: FanSettings): Promise<void> {
      // 1. Task Check
      try {
          await execAsync('schtasks /query /tn "FanControlRestart" /fo CSV /nh');
          this.isTaskMissing = false;
      } catch (e) {
          this.isTaskMissing = true;
      }

      // 2. VBS File Check
      if (settings.fanExe) {
          const exeDir = path.dirname(settings.fanExe);
          const vbsPath = path.join(exeDir, "silent_restart.vbs");
          this.isVbsMissing = !fs.existsSync(vbsPath);
      } else {
          this.isVbsMissing = true; // Cannot check without exe path -> Error
      }
  }

  private sendUacStatusToPi() {
      this.sendToPi({ 
          command: "uacCheck", 
          taskExists: !this.isTaskMissing, 
          vbsExists: !this.isVbsMissing 
      });
  }

  private launchFanControlConfig(
    exePath: string | undefined | null, 
    jsonPath: string | undefined | null, 
    bypassUac: boolean,
    actionObj?: any
  ): void {
    if (!exePath || !fs.existsSync(exePath)) return;
    if (!jsonPath) return; 

    const exeDir = path.dirname(exePath);

    // A) Task Scheduler (via Checkbox)
    if (bypassUac) {
        // Only run VBS if everything is correct. Fallback to Task if VBS is missing.
        if (!this.isTaskMissing && !this.isVbsMissing) {
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
        shell: true, cwd: exeDir, detached: true, windowsHide: true,
      });
      child.on("error", (err) => log.error("Launch error", err));
      child.unref();
    } catch (err) { log.error("Launch Exception", err); }
  }

  private triggerTaskSchedulerRestart(): void {
    log.info("Triggering Task 'FanControlRestart'...");
    const child = spawn('schtasks', ['/run', '/tn', 'FanControlRestart'], {
        detached: true, windowsHide: true
    });
    child.unref();
  }

  private triggerSilentRestart(cwd: string): void {
      log.info("Triggering silent_restart.vbs...");
      // wscript "path/to/silent_restart.vbs"
      // Since we set cwd, the filename is sufficient
      const child = spawn('wscript', ['silent_restart.vbs'], {
          cwd, 
          detached: true, 
          windowsHide: true
      });
      child.on('error', (err) => { log.error("VBS launch error", err); });
      child.unref();
  }

  // ---------- COMMUNICATION & HELPERS ----------

  private validateExe(exePath: string): void {
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
      const controls = data?.Main?.Controls as any[];
      let fans: string[] = [];
      if (Array.isArray(controls)) {
        fans = controls.filter((c) => c.NickName && !c.IsHidden).map((c) => String(c.NickName));
      }
      if (fans.length === 0) {
         const sensors = data?.Main?.FanSensors as any[];
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
        ui.sendToPropertyInspector(message);
      }
    } catch (err) { log.error("Error sending to PI", err); }
  }

  private clearPendingValue(): void {
    if (this.pendingValueTimer) {
      clearTimeout(this.pendingValueTimer);
      this.pendingValueTimer = null;
    }
    this.pendingValue = null;
    this.pendingJsonPath = null;
    this.pendingFanNick = null;
    this.pendingFanExe = null;
    this.pendingCurveIndex = null;
  }
}
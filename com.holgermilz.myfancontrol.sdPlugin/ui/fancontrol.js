// ui/fancontrol.js
// Property Inspector for FanControl using sdpi-components v4

const client = SDPIComponents.streamDeckClient;

console.log("[PI] fancontrol.js loaded", client);

// Global flag: true if an error message is currently displayed
let hasError = false;

// Cache settings to ensure we always have the latest values even if UI is not yet ready
let cachedSettings = {
  fanExe: "",
  jsonFile: "",
  fanNick: ""
};

// ---------- Helpers ----------

// Updates the message box at the bottom of the Property Inspector
function setMessage(text, isError = false) {
  const el = document.getElementById("messageBox");
  if (!el) return;

  el.textContent = text || "";
  el.style.color = isError ? "#ff6b6b" : "#cccccc";

  hasError = !!isError;
}

function getJsonSelect() {
  return document.querySelector('sdpi-select[setting="jsonFile"]');
}

function getFanSelect() {
  return document.querySelector('sdpi-select[setting="fanNick"]');
}

/**
 * Builds the status text shown at the bottom based on current UI selection.
 */
function updateStatusFromUI() {
  if (hasError) {
    return;
  }

  const jsonSelect = getJsonSelect();
  const fanSelect = getFanSelect();

  // Prioritize values from UI elements; fallback to cache if UI is empty
  const json = (jsonSelect && jsonSelect.value) ? jsonSelect.value : cachedSettings.jsonFile;
  const fan = (fanSelect && fanSelect.value) ? fanSelect.value : cachedSettings.fanNick;

  const jsonText = json && json !== "" ? json : "-- no configuration selected --";
  const fanText = fan && fan !== "" ? fan : "-- no fan selected --";

  setMessage(`Configuration: ${jsonText}\nFan: ${fanText}`, false);
}

/**
 * Apply settings received from the plugin to the UI elements.
 */
function applySettingsToUI(settings) {
  if (!settings) settings = {};

  // Update cache immediately
  cachedSettings = { ...settings };

  const exeField = document.querySelector('sdpi-file[setting="fanExe"]');
  const jsonSelect = getJsonSelect();
  const fanSelect = getFanSelect();

  if (exeField && typeof settings.fanExe === "string") {
    try {
      exeField.value = settings.fanExe;
    } catch (e) {
      console.warn("[PI] failed to set exeField.value", e);
    }
  }

  // Attempt to set values (might fail if lists are not yet populated, handled by rebuild logic)
  if (jsonSelect && typeof settings.jsonFile === "string") {
    jsonSelect.value = settings.jsonFile;
  }

  if (fanSelect && typeof settings.fanNick === "string") {
    fanSelect.value = settings.fanNick;
  }

  updateStatusFromUI();
}

/**
 * Rebuilds the dropdown options for JSON configuration files.
 */
function rebuildJsonOptions(files) {
  const jsonSelect = getJsonSelect();
  if (!jsonSelect) {
    console.warn("[PI] jsonFile select not found");
    return;
  }

  // 1. Priority: Current UI selection
  // 2. Priority: Cached setting (from startup)
  let targetValue = jsonSelect.value;
  if (!targetValue && cachedSettings.jsonFile) {
    targetValue = cachedSettings.jsonFile;
  }

  jsonSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "-- select configuration --";
  jsonSelect.appendChild(placeholder);

  const list = Array.isArray(files) ? files : [];
  let exists = false;

  list.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = f;
    jsonSelect.appendChild(opt);
    
    if (f === targetValue) exists = true;
  });

  // Restore selection if it exists in the new list
  jsonSelect.value = exists ? targetValue : "";
}

/**
 * Rebuilds the dropdown options for available fans/controls.
 */
function rebuildFanOptions(fans) {
  const fanSelect = getFanSelect();
  if (!fanSelect) {
    console.warn("[PI] fanNick select not found");
    return;
  }

  // Logic: Prefer user selection, otherwise fallback to cache
  let targetValue = fanSelect.value;
  if (!targetValue && cachedSettings.fanNick) {
    targetValue = cachedSettings.fanNick;
  }

  fanSelect.innerHTML = "";

  const list = Array.isArray(fans) ? fans : [];

  if (list.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "-- no fan available --";
    fanSelect.appendChild(opt);
    fanSelect.value = "";
    return;
  }

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "-- select fan --";
  fanSelect.appendChild(placeholder);

  let exists = false;
  list.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    fanSelect.appendChild(opt);

    if (name === targetValue) exists = true;
  });

  // Set the value if found
  if (exists) {
    fanSelect.value = targetValue;
  } else {
    fanSelect.value = "";
  }
}

// ---------- Init: DOM + Settings ----------

document.addEventListener("DOMContentLoaded", () => {
  const jsonSelect = getJsonSelect();
  const fanSelect = getFanSelect();
  const exeField = document.querySelector('sdpi-file[setting="fanExe"]');

  // Update cache and UI on changes
  if (exeField) {
    exeField.addEventListener("change", (e) => {
      cachedSettings.fanExe = e.target.value; 
      updateStatusFromUI();
    });
  }

  if (jsonSelect) {
    jsonSelect.addEventListener("change", (e) => {
      cachedSettings.jsonFile = e.target.value; 
      updateStatusFromUI();
    });
  }

  if (fanSelect) {
    fanSelect.addEventListener("change", (e) => {
      cachedSettings.fanNick = e.target.value; 
      updateStatusFromUI();
    });
  }

  // Initial status update
  updateStatusFromUI();

  client
    .getSettings()
    .then((result) => {
      console.log("[PI] getSettings result", result);
      const settings = (result && result.settings) ? result.settings : {};
      applySettingsToUI(settings);
    })
    .catch((err) => {
      console.warn("[PI] getSettings failed", err);
    });
});

// Debugging only
client.didReceiveSettings.subscribe((ev) => {
  console.log("[PI] didReceiveSettings", ev.payload?.settings);
});

// ---------- Plugin -> PI Communication (sendToPropertyInspector) ----------

client.sendToPropertyInspector.subscribe((ev) => {
  console.log("[PI] sendToPropertyInspector received:", ev);

  const payload = ev && ev.payload ? ev.payload : {};
  const cmd = payload.command;

  const jsonSelect = getJsonSelect();
  const fanSelect = getFanSelect();

  // ----- exeResult: Plugin validated the EXE path -----
  if (cmd === "exeResult") {
    if (!jsonSelect) {
      console.warn("[PI] jsonFile select not found");
      return;
    }

    if (payload.error) {
      let text = "Unknown error.";
      switch (payload.error) {
        case "wrong_exe": text = "The selected file is not FanControl.exe."; break;
        case "config_folder_missing": text = 'Config folder missing.'; break; 
        case "no_json": text = "No *.json configuration files were found."; break;
      }

      setMessage(text, true);
      jsonSelect.innerHTML = ""; 
      return;
    }

    const files = Array.isArray(payload.files) ? payload.files : [];
    rebuildJsonOptions(files);

    if (files.length > 0) {
      setMessage("Configurations found.", false);
    } else {
      setMessage("No JSON files found.", true);
    }
    return;
  }

  // ----- fanList: Plugin sent available fans -----
  if (cmd === "fanList") {
    const fans = Array.isArray(payload.fans) ? payload.fans : [];
    rebuildFanOptions(fans);

    if (fans.length > 0) {
      setMessage("Configuration loaded.", false);
    } else {
      setMessage("No fans were found in the selected JSON configuration.", true);
    }
    
    // Update status again to reflect potential name changes
    updateStatusFromUI();
    return;
  }

  // ----- selection: Confirm current selection from plugin -----
  if (cmd === "selection") {
    if (hasError) return;

    const json = payload.jsonFile || "";
    const fan = payload.fanNick || "";
    
    // Sync cache
    if(json) cachedSettings.jsonFile = json;
    if(fan) cachedSettings.fanNick = fan;

    const jsonText = json && json !== "" ? json : "-- no configuration selected --";
    const fanText = fan && fan !== "" ? fan : "-- no fan selected --";

    setMessage(`Configuration: ${jsonText}\nFan: ${fanText}`, false);
    return;
  }

  // ----- writeError: Error writing to JSON file -----
  if (cmd === "writeError") {
    setMessage(payload.error || "Error writing configuration file.", true);
    return;
  }

  // ----- uacCheck: Check status of Task and VBS scripts -----
  if (cmd === "uacCheck") {
      const taskError = document.getElementById("taskError");
      const vbsError = document.getElementById("vbsError");
      
      // Update Task Error visibility
      if (taskError) {
          if (payload.taskExists === false) {
              taskError.style.display = "block";
              taskError.style.color = "#ff6b6b"; 
          } else {
              taskError.style.display = "none";
          }
      }

      // Update VBS Error visibility
      if (vbsError) {
          // Check both files
          const vbs1 = payload.vbsExists; // silent_restart
          const vbs2 = payload.adminVbsExists; // admin_action

          if (vbs1 === false || vbs2 === false) {
              vbsError.style.display = "block";
              vbsError.style.color = "#ff6b6b"; 
              
              if (!vbs1 && !vbs2) vbsError.textContent = "Both VBS scripts missing in EXE folder!";
              else if (!vbs2) vbsError.textContent = "File 'admin_action.vbs' missing!";
              else vbsError.textContent = "File 'silent_restart.vbs' missing!";

          } else {
              vbsError.style.display = "none";
          }
      }
      return;
  }
});
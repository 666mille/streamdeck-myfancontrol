const client = SDPIComponents.streamDeckClient;

let kind = "temp";
let selected = "";
let unit = "C";

const STATUS_TEXT = {
  connecting: "Connecting...",
  offline: "FanControl is not running",
  notready: "FanControl is starting...",
  error: "FanControl IPC error",
};
const KIND_TEXT = {
  temp: { label: "Sensor", unit: null, none: "temperature sensors" },
  fan: { label: "Fan", unit: "%", none: "fan controls" },
  rpm: { label: "Fan", unit: "RPM", none: "RPM sensors" },
};

function setStatus(text, isError) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.style.color = isError ? "#ff6b6b" : "#cccccc";
}

function updateLabels() {
  const suffix = kind === "temp" ? ` (°${unit})` : ` (${KIND_TEXT[kind].unit})`;
  document.getElementById("level2Item").setAttribute("label", "Level 2 from" + suffix);
  document.getElementById("level3Item").setAttribute("label", "Level 3 from" + suffix);
}

function rebuildElements(elements) {
  const select = document.querySelector('sdpi-select[setting="element"]');
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = elements.length ? `-- select ${KIND_TEXT[kind].label.toLowerCase()} --` : "-- none available --";
  select.appendChild(placeholder);
  for (const e of elements) {
    const opt = document.createElement("option");
    opt.value = e.id;
    opt.textContent = e.name;
    select.appendChild(opt);
  }
  if (selected && !elements.some((e) => e.id === selected)) {
    const opt = document.createElement("option");
    opt.value = selected;
    opt.textContent = "(not in active profile)";
    select.appendChild(opt);
  }
  select.value = selected;
}

function applySettings(s) {
  s = s || {};
  if (typeof s.element === "string") selected = s.element;
  if (s.unit === "C" || s.unit === "F") unit = s.unit;
  updateLabels();
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const info = await client.getConnectionInfo();
    const uuid = info?.actionInfo?.action || "";
    kind = uuid.endsWith(".fanspeed") ? "fan" : uuid.endsWith(".fanrpm") ? "rpm" : "temp";
  } catch { /* keep default */ }

  document.getElementById("unitItem").style.display = kind === "temp" ? "" : "none";
  document.getElementById("elementItem").setAttribute("label", KIND_TEXT[kind].label);
  document.getElementById("decimalsItem").style.display = kind === "rpm" ? "none" : "";
  document.getElementById("barItem").style.display = kind === "rpm" ? "none" : "";

  document.querySelector('sdpi-select[setting="element"]').addEventListener("change", (e) => { selected = e.target.value; });
  document.querySelector('sdpi-select[setting="unit"]').addEventListener("change", (e) => { unit = e.target.value; updateLabels(); });

  try {
    const res = await client.getSettings();
    applySettings(res?.settings);
  } catch { /* ignore */ }
  updateLabels();
});

client.didReceiveSettings.subscribe((ev) => applySettings(ev?.payload?.settings));

client.sendToPropertyInspector.subscribe((ev) => {
  const p = ev?.payload || {};
  if (p.command !== "fcStatus") return;
  const elements = Array.isArray(p.elements) ? p.elements : [];
  rebuildElements(elements);
  if (p.status === "ok") {
    const profile = p.profile ? `Profile "${p.profile}"\n` : "";
    setStatus(`Connected. ${profile}${elements.length} ${KIND_TEXT[kind].none} available`, elements.length === 0);
  } else {
    setStatus((STATUS_TEXT[p.status] || p.status) + (p.error ? ` (${p.error})` : ""), p.status !== "connecting");
  }
});

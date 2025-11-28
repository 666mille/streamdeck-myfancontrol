# FanControl Encoder for Stream Deck

A Stream Deck+ plugin to control [FanControl](https://getfancontrol.com/) directly via the dials (encoders). This plugin allows you to switch modes, adjust fan speeds, and select fan curves directly from your Stream Deck, interacting directly with FanControl's JSON configuration.

![Stream Deck Demo](imgs/demo.gif)

## Features

* **Control Modes:** Switch between `Auto`, `Manual` (Fixed %), and `Curve` (Software Control) by pushing the dial.
* **Precision Control:**
    * **Manual Mode:** Rotate to adjust fan speed (0-100%).
    * **Curve Mode:** Rotate to cycle through available fan curves defined in FanControl.
* **Live Feedback:** Shows current fan name, mode, value/curve, and error states on the touch strip.
* **Silent Reload (UAC Bypass):** Optional feature to reload the FanControl configuration without "Run as Administrator" prompts using Windows Task Scheduler.

## Prerequisites

* Windows 10 or 11
* Elgato Stream Deck+ (with dials)
* [FanControl](https://getfancontrol.com/) (by Rem0o) installed and configured.
    * **Recommendation:** Use the **portable version** of FanControl.
    * **Important:** Place the folder in a simple location like `C:\FanControl` or `D:\Tools\FanControl`. **Avoid** placing it in `C:\Program Files` or `C:\Program Files (x86)`, as strict Windows permissions there can prevent the plugin or helper scripts from working correctly.

## Installation

1.  Download the latest `.streamDeckPlugin` release.
2.  Double-click the file to install it to your Stream Deck software.
3.  Drag the **FanControl Encoder** action to a dial stack on your Stream Deck+.

## Configuration

### Basic Setup
1.  **Path to FanControl EXE:** Select your `FanControl.exe`.
2.  **Select JSON Configuration:** Choose your configuration file (usually `userConfig.json` inside the `Configurations` folder).
3.  **Select Fan:** Choose the fan or control sensor you want to control with this dial.

### ⚠️ Important: Setting up the UAC Bypass (Silent Restart)

**Why is this necessary?**
Every time you change a value (Speed, Mode, Curve) via the Stream Deck, the plugin updates the configuration file and **must restart FanControl** to apply the changes immediately.
Without this bypass, Windows User Account Control (UAC) will trigger a popup ("Do you want to allow this app to make changes?") **every single time** you touch the dial.

To enable a seamless, silent restart in the background, follow these steps:

**If you enable "Bypass UAC prompt" in the plugin settings without these steps, the plugin will show an ERROR.**

#### Step 1: Create the Helper Script
**Why VBS?** We use a VBScript instead of a simple Batch (`.bat`) or PowerShell script because CMD and PowerShell always open a visible terminal window briefly. This VBScript executes the restart completely silently in the background without any popping up windows.

1.  Go to the folder where your `FanControl.exe` is located.
2.  Create a new text file and paste the following code:
    ```vbscript
    Set WshShell = CreateObject("WScript.Shell")
    ' 1. Kill FanControl if running
    WshShell.Run "taskkill /F /IM FanControl.exe", 0, True
    ' 2. Run the Scheduled Task
    WshShell.Run "schtasks /run /tn ""FanControlRestart""", 0, False
    ```
3.  Save the file as **`silent_restart.vbs`** (Make sure it is NOT named `.vbs.txt`).

#### Step 2: Create the Windows Task
1.  Open **Task Scheduler** (`taskschd.msc`).
2.  Click **Create Task...** (on the right).
3.  **General Tab:**
    * Name: `FanControlRestart` (Exact spelling is important!).
    * Check **Run with highest privileges**.
    * Select **Run only when user is logged on**.
4.  **Actions Tab:**
    * Click **New...** -> **Start a program**.
    * Browse and select your `FanControl.exe`.
5.  **Conditions Tab:**
    * **Uncheck** "Start the task only if the computer is on AC power" (Important for laptops).
6.  **Settings Tab:**
    * Check **Allow task to be run on demand**.
    * If the task is already running: **Run a new instance in parallel** (or Stop the existing instance).
7.  Click **OK**.

#### Step 3: Enable in Plugin
* In the Stream Deck software, check the box **"Use silent restart (Task Scheduler)"**.
* If everything is correct, the error message on the dial will disappear.

## Usage

* **Push Dial:** Enters "Selection Mode" (Title turns blue).
    * Rotate to choose: `AUTO`, `MAN` (Manual), or `CURVE`.
    * Push again to confirm and apply.
* **Rotate Dial (Normal Mode):**
    * **Manual:** Increases/Decreases fan speed %.
    * **Curve:** Cycles through the list of curves defined in your JSON.
    * **Auto:** **No action.** In Auto mode, the fan is controlled entirely by FanControl logic. Manual adjustments are disabled to prevent conflicts.

## Troubleshooting

* **Red "ERROR" Screen:**
    * **"Missing Task":** The task `FanControlRestart` does not exist in Windows Task Scheduler.
    * **"Missing VBS":** The file `silent_restart.vbs` was not found in the same folder as `FanControl.exe`.
* **Changes not applying:** Make sure FanControl is running. If UAC bypass is off, check if a UAC prompt is hidden behind other windows.

## Disclaimer

This plugin is not affiliated with Elgato or the creator of FanControl. Use at your own risk.

## License

[MIT License](LICENSE)

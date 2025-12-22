# FanControl Encoder for Stream Deck

A Stream Deck+ plugin to control [FanControl](https://getfancontrol.com/) directly via the dials (encoders). This plugin allows you to switch modes, adjust fan speeds, and select fan curves directly from your Stream Deck, interacting directly with FanControl's JSON configuration.

![Stream Deck Demo](imgs/demo.gif)

## Features

* **Control Modes:** Switch between `Auto`, `Manual` (Fixed %), and `Curve` (Software Control) by pushing the dial.
* **Precision Control:**
    * **Manual Mode:** Rotate to adjust fan speed (0-100%).
    * **Curve Mode:** Rotate to cycle through available fan curves defined in FanControl.
* **Live Feedback:** Shows current fan name, mode, value/curve, and error states on the touch strip.
* **Seamless Profile Switching (UAC Bypass):** Optional feature to switch FanControl configurations instantly and silently using Windows Task Scheduler, preventing "ghost" icons in the tray.

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

To enable a seamless, silent restart in the background, we use a **two-script method** to handle Windows permissions correctly (User vs. Admin).

**If you enable "Bypass UAC prompt" in the plugin settings without these steps, the plugin will show an ERROR.**

#### Step 1: Create the Helper Scripts
We need two scripts in your FanControl folder. One for the Stream Deck (User trigger) and one for the Task Scheduler (Admin worker).

1.  Go to the folder where your `FanControl.exe` is located (e.g., `C:\FanControl`).

2.  **Create Script A (`silent_restart.vbs`):**
    * Create a new text file, paste the code below, and save it as **`silent_restart.vbs`**.
    ```vbscript
    Set WshShell = CreateObject("WScript.Shell")
    ' Trigger the Task Scheduler to do the heavy lifting
    WshShell.Run "schtasks /run /tn ""FanControlRestart""", 0, False
    ```

3.  **Create Script B (`admin_action.vbs`):**
    * Create another text file, paste the code below, and save it as **`admin_action.vbs`**.
    * *Note: This script now reads the requested configuration from a temporary file (`active_config.txt`) created by the plugin and switches the profile instantly without killing the app.*

    ```vbscript
    Set WshShell = CreateObject("WScript.Shell")
    Set fso = CreateObject("Scripting.FileSystemObject")

    ' Determine path to config text file (located in the same folder as this script)
    strPath = WScript.ScriptFullName
    strFolder = fso.GetParentFolderName(strPath)
    strConfigFile = fso.BuildPath(strFolder, "active_config.txt")

    ' Default config if file is not readable (Fallback)
    configName = "userConfig.json"

    ' Try to read the active config filename from the text file
    If fso.FileExists(strConfigFile) Then
        Set objFile = fso.OpenTextFile(strConfigFile, 1)
        If Not objFile.AtEndOfStream Then
            configName = objFile.ReadLine
        End If
        objFile.Close
    End If

    WshShell.Run "FanControl.exe -m -c " & Chr(34) & configName & Chr(34), 0, False
    ```

#### Step 2: Create the Windows Task
1.  Open **Task Scheduler** (`taskschd.msc`).
2.  Click **Create Task...** (on the right).
3.  **General Tab:**
    * Name: `FanControlRestart` (Exact spelling is important!).
    * **Check "Run with highest privileges"** (Crucial! Without this, FanControl won't close).
    * Select **Run only when user is logged on**.
4.  **Actions Tab:**
    * Click **New...** -> **Start a program**.
    * **Program/script:** `wscript.exe`
    * **Add arguments:** `"C:\Path\To\Your\FanControl\admin_action.vbs"`
        *(⚠️ Important: Use quotes around the path! Adjust the path to your folder!)*
    * **Start in:** `C:\Path\To\Your\FanControl\`
        *(⚠️ Important: NO quotes here! This ensures FanControl finds the JSON config.)*
5.  **Conditions Tab:**
    * **Uncheck** "Start the task only if the computer is on AC power" (Important for laptops).
6.  **Settings Tab:**
    * Check **Allow task to be run on demand**.
    * If the task is already running: **Stop the existing instance**.
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
    * **"Missing VBS":** One of the helper scripts (`silent_restart.vbs` or `admin_action.vbs`) was not found in the same folder as `FanControl.exe`.
* **FanControl does not close/restart (Icon stays in tray):**
    * This usually means the Task Scheduler doesn't have permission to kill the process.
    * Check Step 2: Did you enable **"Run with highest privileges"**?
    * Check Step 2: Did you point the Action to `admin_action.vbs`?
* **FanControl restarts but old values remain:**
    * Wait time might be too short. Try increasing `WScript.Sleep 500` to `2000` in `admin_action.vbs`.

## ⚠️ DISCLAIMER & WARNING

**USE AT YOUR OWN RISK.**

* **Risk of Overheating:** Manually turning off fans (0%) or setting insufficient fan speeds can lead to severe **hardware overheating** and permanent damage to your components.
* **No Warranty:** This plugin is **not** affiliated with Elgato, Corsair, or the developer of FanControl (Rem0o). The author of this plugin accepts **no liability** for any software issues, hardware damage, or data loss resulting from the use of this tool.
* **Responsibility:** Always monitor your system temperatures when manually controlling fan curves. Ensure that critical cooling systems (CPU/GPU) have fail-safes enabled in your BIOS.
License

## License

[MIT License](LICENSE)

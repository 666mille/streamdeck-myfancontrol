# FanControl for Stream Deck v1.1.0

## New: Live display keys (any Stream Deck)

Three new key actions show live values from FanControl on **any Stream Deck model** – no Stream Deck+ required:

- **Temperature Display** – any temperature sensor known to FanControl (hardware or custom sensor), in °C or °F. Press the key to toggle the unit.
- **Fan Speed Display** – current output (%) of a fan control, with level bar.
- **Fan RPM Display** – current speed (RPM) of a fan sensor.

Features:
- **No setup:** values are read directly from the running FanControl (app or service). No extra FanControl plugin, no EXE path, no password.
- **Your names:** sensors are shown with the nicknames from your active FanControl configuration.
- **Color levels:** three configurable colors with thresholds (e.g. green < 60 °C, yellow from 60 °C, red from 80 °C), applied to value and bar or to the whole key background.
- **°C / °F:** thresholds are converted automatically when switching the unit.
- **Status display:** `OFFLINE` when FanControl is not running, `NOT FOUND` when a sensor no longer exists.

## Changes
- README: requirements split into display keys (any Stream Deck) and dial (Stream Deck+).
- Manifest: corrected repository URL and description.

## Notes
- The display keys use FanControl's internal local interface (named pipe). It is not officially documented and was verified with FanControl **V286**; a future FanControl update could change it.
- The dial action is unchanged.

## Installation
Download `com.holgermilz.myfancontrol.streamDeckPlugin` below and double-click it. Existing dial settings are kept.

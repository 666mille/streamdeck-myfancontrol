import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { installLifecycle } from "./lifecycle.js";
import { FanControlEncoder } from "./actions/fan-control-encoder.js";

// Clean shutdown when Stream Deck quits + lifecycle log (see lifecycle.ts).
// The encoder registers its own cleanup (stop timers) via onShutdown().
installLifecycle("com.holgermilz.myfancontrol");

// Set log level to INFO for release
streamDeck.logger.setLevel(LogLevel.INFO);

const log = streamDeck.logger.createScope("PluginMain");

log.info("Plugin starting, registering actions");

// Register fan control action
streamDeck.actions.registerAction(new FanControlEncoder());

log.info("Connecting to Stream Deck");
streamDeck.connect().catch((err) => streamDeck.logger.error(`connect failed: ${err}`));

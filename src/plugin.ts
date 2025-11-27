import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { FanControlEncoder } from "./actions/fan-control-encoder.js";

// Set log level to INFO for release
streamDeck.logger.setLevel(LogLevel.INFO);

const log = streamDeck.logger.createScope("PluginMain");

log.info("Plugin starting, registering actions");

// Register fan control action
streamDeck.actions.registerAction(new FanControlEncoder());

log.info("Connecting to Stream Deck");
streamDeck.connect();
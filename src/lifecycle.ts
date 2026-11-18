// src/lifecycle.ts
// Clean shutdown and crash diagnostics (same module as in MyJBxHeadsetControl,
// MyATxMouseControl and streamdeck-wled-control).
//
// Background: the Elgato SDK (1.x up to 3.x) attaches neither "close" nor "error" to its
// WebSocket. When Stream Deck quits (e.g. on Windows shutdown), this process keeps
// running: the 2 s poll keeps reading the FanControl JSON (which FanControl rewrites
// while it exits) and a pending dial change could still start schtasks/wscript while
// Windows is shutting down. Windows then terminates node20.exe the hard way.
//
// Therefore:
//  - detect the end of the Stream Deck connection (WebSocket close, parent process gone,
//    console/session signals) and shut down on the JS main thread: stop all timers,
//    drop pending writes, then exit;
//  - keep uncaught errors from killing the process (the SDK only registers process.once);
//  - write every lifecycle event synchronously to logs/lifecycle.log, so after a crash
//    the log shows whether THIS plugin shut down cleanly.
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "lifecycle.log");
const MAX_LOG_BYTES = 256 * 1024;
const HARD_EXIT_MS = 1500; // cleanup gets this long, then we exit anyway

type Cleanup = () => void | Promise<void>;
const cleanups: Cleanup[] = [];
let shuttingDown = false;

/** Synchronous append to an own file - works even inside the exit handler. */
export function lifeLog(msg: string): void {
    const line = `${new Date().toISOString()} [pid ${process.pid}] ${msg}\n`;
    try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        try {
            if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
        } catch { /* file does not exist yet */ }
        fs.appendFileSync(LOG_FILE, line);
    } catch { /* logging must never throw */ }
}

function errText(e: unknown): string {
    return e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
}

export function isShuttingDown(): boolean {
    return shuttingDown;
}

/** Registers a cleanup step (stop timers etc.). Runs in registration order. */
export function onShutdown(fn: Cleanup): void {
    cleanups.push(fn);
}

export function shutdown(reason: string, exitCode = 0): void {
    if (shuttingDown) return;
    shuttingDown = true;
    lifeLog(`Shutdown: ${reason}`);

    // Safety net: never hang during Windows shutdown.
    setTimeout(() => {
        lifeLog(`Cleanup did not finish within ${HARD_EXIT_MS} ms, exiting anyway`);
        process.exit(exitCode);
    }, HARD_EXIT_MS).unref();

    (async () => {
        for (const fn of cleanups) {
            try { await fn(); } catch (e) { lifeLog(`Cleanup error: ${errText(e)}`); }
        }
        lifeLog("Cleanup done");
        process.exit(exitCode);
    })();
}

/** Call once at plugin start, before streamDeck.connect(). */
export function installLifecycle(pluginUuid: string): void {
    lifeLog(`Start ${pluginUuid} ppid=${process.ppid} node=${process.version}`);

    // Hook into the ws class the SDK uses (same module instance in the bundle).
    const proto = (WebSocket as any).prototype;
    const origEmit = proto.emit;
    proto.emit = function (this: any, event: string, ...args: unknown[]): boolean {
        if (event === "error" && this.listenerCount("error") === 0) {
            lifeLog(`WebSocket error (no listener): ${errText(args[0])}`);
            return true; // would otherwise be thrown as uncaughtException
        }
        if (event === "close") {
            const r = origEmit.call(this, event, ...args);
            shutdown(`WebSocket to Stream Deck closed (code ${String(args[0])})`);
            return r;
        }
        return origEmit.call(this, event, ...args);
    };

    // Fallback: Stream Deck process gone?
    const parentPid = process.ppid;
    setInterval(() => {
        try { process.kill(parentPid, 0); } catch (e: any) {
            if (e?.code === "ESRCH") shutdown(`parent process ${parentPid} gone`);
        }
    }, 2000).unref();

    // SIGHUP = console/session closes (Windows logoff/shutdown), SIGBREAK = Ctrl+Break
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
        process.on(sig, () => shutdown(sig));
    }

    process.on("uncaughtException", (err) => lifeLog(`uncaughtException: ${errText(err)}`));
    process.on("unhandledRejection", (reason) => lifeLog(`unhandledRejection: ${errText(reason)}`));
    process.on("exit", (code) => {
        lifeLog(shuttingDown ? `exit, code ${code}` : `exit, code ${code} - without orderly shutdown!`);
    });
}

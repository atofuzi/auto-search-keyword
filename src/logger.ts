/**
 * Simple logger with level control via LOG_LEVEL environment variable.
 * LOG_LEVEL: debug | info | warn | error (default: info)
 */

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const rawLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const currentLevel = LEVELS[rawLevel] ?? 1;

export const logger = {
    debug: (msg: string) => {
        if (currentLevel <= 0) console.log(`[DEBUG] ${msg}`);
    },
    info: (msg: string) => {
        if (currentLevel <= 1) console.log(`[INFO]  ${msg}`);
    },
    warn: (msg: string) => {
        if (currentLevel <= 2) console.warn(`[WARN]  ${msg}`);
    },
    error: (msg: string, err?: any) => {
        if (currentLevel <= 3) console.error(`[ERROR] ${msg}`, err ?? '');
    },
};

/** Returns true when debug logging is enabled (used to control socket debug logs) */
export const isDebugEnabled = () => currentLevel <= 0;

// Authoring-only type declarations for the Mini App Node entry.
// Derived from the documented runtime API; never imported at runtime.

export interface MiniAppLogger {
  debug(code: string, fields?: Record<string, unknown>): void;
  info(code: string, fields?: Record<string, unknown>): void;
  warn(code: string, fields?: Record<string, unknown>): void;
  error(code: string, fields?: Record<string, unknown>): void;
}

export interface MiniAppContext {
  pluginId: string;
  pluginRoot: string;
  dataDir: string;
  listen: { host: string; port: number };
  signal: AbortSignal;
  logger: MiniAppLogger;
  hostConnector?: unknown;
}

export interface MiniAppLifecycle {
  dispose(): Promise<void> | void;
}

export interface MiniAppModule {
  start(context: MiniAppContext): Promise<MiniAppLifecycle>;
}

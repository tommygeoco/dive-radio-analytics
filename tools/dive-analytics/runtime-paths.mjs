// runtime-paths.mjs — durable operational state that must not dirty the Git
// checkout used to build and publish the dashboard.

import { homedir } from "node:os";
import { join } from "node:path";

export const RUNTIME_DIR = process.env.DIVE_RUNTIME_DIR
  || join(homedir(), "Library", "Application Support", "Dive Radio Analytics");
export const ISOLATED_PUBLISHER_ROOT = process.env.DIVE_PUBLISHER_ROOT
  || join(RUNTIME_DIR, "publisher-main");
export const ALERT_QUEUE_PATH = process.env.DIVE_ALERT_QUEUE_PATH
  || join(RUNTIME_DIR, "alerts-pending.json");
export const ALERT_STATE_PATH = process.env.DIVE_ALERT_STATE_PATH
  || join(RUNTIME_DIR, "alerts-state.json");
export const DAILY_STATE_PATH = process.env.DIVE_DAILY_STATE_PATH
  || join(RUNTIME_DIR, "daily-attempts.json");
export const PUBLISH_PROOF_PATH = process.env.DIVE_PUBLISH_PROOF_PATH
  || join(RUNTIME_DIR, "publish-proof.json");
export const RECOVERY_PROOF_PATH = process.env.DIVE_RECOVERY_PROOF_PATH
  || join(RUNTIME_DIR, "recovery-proof.json");
export const TRANSCRIPT_REFRESH_STATE_PATH = process.env.DIVE_TRANSCRIPT_REFRESH_STATE
  || join(RUNTIME_DIR, "transcript-index-refresh-needed.json");

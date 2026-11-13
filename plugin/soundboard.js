import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  createConfigStore,
  createThrottle,
  isDisabled,
  planEventSound,
  playSound,
  resolveEventKey,
  selectPlayer,
} from "./soundboard-core.js"

const PLUGIN_ID = "opencode-echosound"

// One opencode server can load the plugin once per location while every
// instance sees the same event stream, so remember played event ids process-wide.
const SEEN_KEY = Symbol.for("opencode-echosound.seen")
const seen = (globalThis[SEEN_KEY] ??= new Set())

const firstSeen = (event) => {
  const id = event?.id
  if (typeof id !== "string") return true
  if (seen.has(id)) return false
  seen.add(id)
  if (seen.size > 500) seen.delete(seen.values().next().value)
  return true
}

export function createEchosound({ directory, env = process.env, log = () => {} } = {}) {
  const store = createConfigStore({ env, directory })
  const fallbackDir = directory || process.cwd()
  let throttle = null
  let throttleStamp = null
  let playerCache = null
  let playerStamp = null

  const runtime = () => {
    const state = store.get()
    const stamp = `${state.path}:${state.error ?? ""}:${state.config.player}:${state.config.throttleMs}`
    if (playerStamp !== stamp) {
      playerCache = selectPlayer(state.config.player, env)
      playerStamp = stamp
    }
    if (throttleStamp !== stamp) {
      throttle = createThrottle({
        globalMs: state.config.throttleMs,
        perKeyMs: state.config.throttleMs,
      })
      throttleStamp = stamp
    }
    return { state, player: playerCache, throttle }
  }

  return function handleEvent(event) {
    try {
      const type = event?.type
      if (!type) return
      const { state, player, throttle: gate } = runtime()
      if (state.config.debug && !QUIET_EVENT.test(type)) log("debug", `event ${type}`, eventSummary(event))
      const gateState = isDisabled({ config: state.config, env })
      if (gateState.disabled) {
        if (state.config.debug) log("debug", `skipped ${type}: ${gateState.reason}`)
        return
      }
      const key = resolveEventKey(state.config, type)
      if (!key) return
      if (!firstSeen(event)) return
      if (!gate.allow(key)) return
      if (state.error) log("error", state.error)
      if (player?.error) log("warn", player.error)
      // relative sound paths are relative to the sounds.json that named them
      const baseDir = state.path ? dirname(state.path) : fallbackDir
      const plan = planEventSound({ config: state.config, eventType: key, baseDir, player })
      if (!plan) return
      if (!plan.exists) {
        log("warn", `sound file not found for ${type}: ${plan.path}`)
        return
      }
      const onExit = state.config.debug ? (outcome) => log("debug", `player exited for ${type}`, outcome) : undefined
      const result = playSound({ player, file: plan.path, volume: plan.volume, env, onExit })
      if (state.config.debug) {
        log(result.ok ? "info" : "error", `${type} -> ${plan.path} (${plan.volume}%)`, result.ok ? { player: player.name, args: result.args } : { error: result.error })
      }
    } catch (error) {
      log("error", "event handler failed", { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

// Event payloads carry prompts, reasoning and tool input; log only identifiers.
const SUMMARY_KEYS = ["sessionID", "status", "finish", "error"]

function eventSummary(event) {
  const data = event?.data ?? event?.properties
  if (!data || typeof data !== "object") return undefined
  const summary = {}
  for (const key of SUMMARY_KEYS) {
    const value = data[key]
    if (value === undefined) continue
    summary[key] = typeof value === "object" && value !== null ? JSON.stringify(value).slice(0, 120) : String(value).slice(0, 120)
  }
  return summary
}

const QUIET_EVENT = /(\.delta|\.streamed|\.progress|^session\.tool\.|^shell\.|^session\.usage\.)/

// The opencode service sends stdout to /dev/null, so debug output goes to a file.
export const DEBUG_LOG_PATH = join(homedir(), ".local", "share", "opencode", "echosound.log")

function createFileLog({ env = process.env, directory } = {}) {
  const store = createConfigStore({ env, directory })
  return (level, message, extra) => {
    try {
      if (!store.get().config.debug && level !== "error") return
      mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true })
      const tail = extra === undefined ? "" : ` ${JSON.stringify(extra)}`
      appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${level} ${message}${tail}\n`)
    } catch {
      return
    }
  }
}

export default {
  id: PLUGIN_ID,
  setup(ctx) {
    const controller = new AbortController()
    const directory = ctx?.location?.directory
    const log = createFileLog({ directory })
    const handleEvent = createEchosound({ directory, log })
    log("debug", "setup", { directory: directory ?? null })

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        handleEvent(event)
      }
      log("debug", "event stream ended", { aborted: controller.signal.aborted })
    })().catch((error) => {
      if (!controller.signal.aborted) log("error", "event stream stopped", { error: error instanceof Error ? error.message : String(error) })
    })

    return () => controller.abort()
  },
}

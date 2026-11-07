# SmokeDiver

A breathing-apparatus air-management trainer driven by your real breath, read from a webcam with the **Presage SmartSpectra SDK**.

Firefighters entering smoke breathe from a cylinder that runs out. Panicked breathing empties it fast; slow, controlled breathing buys minutes. In SmokeDiver you search a smoke-filled warehouse for a missing worker while your live breathing drains a simulated cylinder, your pulse sets the heartbeat you hear, and entry control calls you on the radio — you answer out loud, and the SDK's talking detection confirms you spoke (no microphone is used).

> A training game. Not a medical device, not a fitness-for-duty test, and the cylinder is a simulation, not a measurement of real air use.

## How SmartSpectra signals drive the game

| SmartSpectra signal | Metric | What it does in SmokeDiver |
| --- | --- | --- |
| Breathing rate | `BREATHING_RATE` | Main driver of air use. Faster breathing drains the cylinder faster. |
| Breathing amplitude | `BREATHING_AMPLITUDE` | Deeper breaths than your baseline use more air. |
| Inhale:exhale ratio | `INHALE_EXHALE_RATIO` | Feeds the live **breath control** score (long exhale = good technique). |
| Chest breathing trace | `CHEST_BREATHING` | Detects each inhale and exhale: the demand valve hisses as you breathe in and your mask fogs as you breathe out. Drawn live on the HUD. |
| Pulse rate | `PULSE_RATE` | Heartbeat sound and screen throb at your live pulse. |
| Talking | `TALKING` | Radio reports to entry control are confirmed when the SDK sees you speaking. |
| Readiness codes | `validationStatus` | Mask-check guidance, and the mission pauses (air and clock frozen) if your face leaves the frame. |
| HRV | `HRV` | Requested as part of the cardio bundle; not used for any judgement. |

The air model lives in [`src/renderer/game/air.js`](src/renderer/game/air.js): ventilation = breathing rate × relative depth (vs. your 30-second baseline) × a talking factor, scaled into a 300 bar training cylinder with the low-pressure whistle at 55 bar.

## Run it (Windows, macOS Apple Silicon, Linux x64)

1. Install [Node.js](https://nodejs.org) 20 or newer (24 LTS recommended).
2. In this folder:
   ```bash
   npm install
   ```
   This downloads Electron and the SmartSpectra native runtime for every supported platform (a few hundred MB; only yours is loaded).
3. Get a free API key at [physiology.presagetech.com](https://physiology.presagetech.com/), then copy `.env.example` to `.env` and paste it in:
   ```
   SMARTSPECTRA_API_KEY=your-key
   ```
4. Start:
   ```bash
   npm start
   ```

No key or no camera? `npm run sim` opens the keyboard simulator (hold **Space** to breathe in, **V** to talk, **B** for auto-breathing). It's clearly labelled as simulated and is meant for trying the game, not for judging the SDK integration.

### Tips for a clean signal
Sit about an arm's length from the camera with a light in front of you, shoulders and upper chest in view, arms resting. Keep your body still; play with the keyboard only.

### Controls
`W A S D` / arrow keys move · `E` picks up the casualty or leaves at the exit · `M` toggles sound.

## Consent and data handling

- **Consent first.** The camera turns on only after an explicit consent screen, and only during the mask check, the breathing baseline and the mission. The SDK is stopped the moment a mission ends.
- **On-device processing.** Video frames are processed by the SmartSpectra SDK on your computer. SmokeDiver never records or stores video, images or face landmarks.
- **Camera only.** Electron is configured to grant this app camera permission only. The microphone is never requested; talking is detected visually.
- **Telemetry off.** The SDK's aggregate telemetry is disabled (`enableTelemetry: false`). See Presage's [telemetry and privacy notes](https://smartspectra.presagetech.com/docs/telemetry-and-privacy/).
- **Automatic SDK insights (disclosed).** Per Presage's [LLM Insights documentation](https://presagetech.com/docs/smartspectra-sdk/llm-insights), while a session runs the SDK itself automatically sends snapshots of derived pulse rate, HRV and breathing rate (never video or images) to Presage's insights service, about once a minute. SmokeDiver never requests or displays insights and has no setting to stop these snapshots; Presage's privacy policy governs retention and deletion. **Breathing-only mode** (consent screen) skips the cardio metrics entirely.
- **Network.** Besides the above, the SDK contacts Presage to validate the API key, check usage and load models. SmokeDiver itself sends nothing anywhere.
- **Local storage.** Each finished run's summary (pressure, breathing rate, pulse and score over time; no imagery) is saved to `runs.json` in the app data folder (`%APPDATA%\SmokeDiver` on Windows), capped at 50 runs. **Past runs → Delete all runs** removes the file.
- **Not medical.** No diagnosis, treatment or fitness-for-duty claims. The breath-control score rates a breathing technique for the game.
- **One person, with consent.** Only the player should be on camera.

## Project layout

```
main.js                     Electron main: .env key, SDK IPC bridge, camera-only permission, run storage
src/preload.js              Presage preload bridge + small SmokeDiver API (bundled for sandboxed preload)
src/renderer/app.js         Screen flow: consent → mask check → baseline → briefing → mission → debrief
src/renderer/signals/       live.js (SmartSpectra), sim.js (keyboard), breathPhase.js (inhale/exhale detection)
src/renderer/game/          mission.js, air.js (cylinder model), gauge.js, map.js, audio.js (synthesised sounds)
src/renderer/debrief.js     Chart, radio log, coaching
test/shoot.js               Automated simulator walkthrough with screenshots
test/live-wiring.js         Live SDK path with Chromium's fake camera (checks error handling)
```

## Tests

```bash
npm run build
npx electron test/shoot.js                                    # simulator walkthrough → test/shots/
SMARTSPECTRA_API_KEY=invalid npx electron test/live-wiring.js # live path with a fake camera
```

## Credits

Built for the [Presage SmartSpectra SDK Challenge](https://dev.to/devteam/join-the-presage-smartspectra-sdk-challenge-3000-in-prizes-across-10-winners-1370) on DEV. Uses `@smartspectra/node-sdk` (Presage Technologies, proprietary licence), Electron and Chart.js. All sounds are synthesised in code.

SmokeDiver's own code: MIT.

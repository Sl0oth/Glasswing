// Runs off the main thread: downloads a filter list set and compiles it, which takes several seconds
// and would otherwise freeze the browser. The result is saved to a file for blocker.js to load.
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const { FiltersEngine } = require('@ghostery/adblocker')

const BUILDERS = {
  ads: () => FiltersEngine.fromPrebuiltAdsOnly(fetch),
  combined: () => FiltersEngine.fromPrebuiltAdsAndTracking(fetch),
}

BUILDERS[workerData.kind]()
  .then((engine) => {
    fs.writeFileSync(workerData.file, engine.serialize())
    parentPort.postMessage({ ok: true })
  })
  .catch((err) => parentPort.postMessage({ ok: false, error: String(err?.message ?? err) }))

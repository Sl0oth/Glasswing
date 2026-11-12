// Tells the browser how many camera and microphone tracks this page still has running.
//
// Electron says when a site is given the camera or mic (src/main/permissions.js) but not when it
// stops, so the end of a recording has to be noticed from inside the page. If this script is broken
// or bypassed nothing gets reported, which leaves the tab's icon on: the safe way to be wrong.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.executeInMainWorld({
  args: [(audio, video) => ipcRenderer.send('tab:capture', audio, video)],
  func: (report) => {
    if (!navigator.mediaDevices) return // pages that aren't secure can't record

    // Held on to now, so that a page replacing them later can't change the count.
    const { apply } = Reflect
    const trackProto = MediaStreamTrack.prototype
    const streamProto = MediaStream.prototype
    const readyState = Object.getOwnPropertyDescriptor(trackProto, 'readyState').get
    const kind = Object.getOwnPropertyDescriptor(trackProto, 'kind').get
    const getTracks = streamProto.getTracks
    const cloneTrack = trackProto.clone
    const cloneStream = streamProto.clone
    const deref = WeakRef.prototype.deref
    const has = WeakSet.prototype.has
    const remember = WeakSet.prototype.add
    const every = setInterval
    const stopEvery = clearInterval
    const Ref = WeakRef

    const POLL_MS = 1000
    const known = new WeakSet()
    // Weak, so this never keeps a camera on after a page has let go of its stream.
    let tracks = []
    let timer = null
    let lastAudio = 0
    let lastVideo = 0

    const scan = (always = false) => {
      const kept = []
      let audio = 0
      let video = 0
      for (let i = 0; i < tracks.length; i++) {
        const track = apply(deref, tracks[i], [])
        if (!track || apply(readyState, track, []) !== 'live') continue
        kept[kept.length] = tracks[i]
        if (apply(kind, track, []) === 'audio') audio++
        else video++
      }
      tracks = kept
      if (!tracks.length && timer !== null) {
        stopEvery(timer)
        timer = null
      }
      if (always || audio !== lastAudio || video !== lastVideo) report(audio, video)
      lastAudio = audio
      lastVideo = video
    }

    const watchTrack = (track) => {
      apply(remember, known, [track])
      tracks[tracks.length] = new Ref(track)
      if (timer === null) timer = every(scan, POLL_MS)
    }

    const watchStream = (stream) => {
      const list = apply(getTracks, stream, [])
      for (let i = 0; i < list.length; i++) watchTrack(list[i])
      scan(true)
    }

    // A request that failed has to report too: the browser assumed it would work when it said yes.
    const settle = () => scan(true)

    const devicesProto = MediaDevices.prototype
    const getUserMedia = devicesProto.getUserMedia
    devicesProto.getUserMedia = {
      getUserMedia(...args) {
        const request = apply(getUserMedia, this, args)
        request.then(watchStream, settle)
        return request
      },
    }.getUserMedia

    for (const name of ['getUserMedia', 'webkitGetUserMedia']) {
      const legacy = Navigator.prototype[name]
      if (!legacy) continue
      Navigator.prototype[name] = {
        [name](constraints, success, failure) {
          const ok = (stream) => {
            watchStream(stream)
            success?.(stream)
          }
          const failed = (error) => {
            settle()
            failure?.(error)
          }
          return apply(legacy, this, [constraints, ok, failed])
        },
      }[name]
    }

    // A copy keeps the device open after the original stops.
    trackProto.clone = {
      clone() {
        const copy = apply(cloneTrack, this, [])
        if (apply(has, known, [this])) watchTrack(copy)
        return copy
      },
    }.clone

    streamProto.clone = {
      clone() {
        const before = apply(getTracks, this, [])
        const copy = apply(cloneStream, this, [])
        const after = apply(getTracks, copy, [])
        for (let i = 0; i < after.length; i++) {
          if (before[i] && apply(has, known, [before[i]])) watchTrack(after[i])
        }
        return copy
      },
    }.clone
  },
})

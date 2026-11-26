// Makes jsRuntime() see Electron's node mode, or plain Node, whatever runs the test. The flags it
// gives inside Electron run on plain Node too, where ELECTRON_RUN_AS_NODE means nothing.

function seeVersions(electron: string | undefined): () => void {
  const saved = Object.getOwnPropertyDescriptor(process, "versions") as PropertyDescriptor;
  const { electron: _running, ...versions } = process.versions;
  Object.defineProperty(process, "versions", {
    ...saved,
    value: electron === undefined ? versions : { ...versions, electron },
  });
  return () => Object.defineProperty(process, "versions", saved);
}

/** Until the returned function runs, jsRuntime() answers as inside Electron 45. */
export function asElectron(): () => void {
  return seeVersions("45.5.0");
}

/** Until the returned function runs, jsRuntime() answers as on plain Node: never spawn with it. */
export function asNode(): () => void {
  return seeVersions(undefined);
}

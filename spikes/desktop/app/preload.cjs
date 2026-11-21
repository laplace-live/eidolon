// Sandboxed CommonJS preload: the only crossing between the page and the shell. It carries no
// credential; the forwarder in main adds the Bearer to every eidolon-app://app request.
"use strict";
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("eidolonDesktop", Object.freeze({ platform: process.platform, shell: "spike" }));
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.shell = process.platform === "darwin" ? "mac" : "win";
});

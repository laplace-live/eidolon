// Who sent an IPC message: the window, by its webContents, and whether its main frame; plain objects
// stand in for webContents and frames.
import { expect, test } from "vitest";
import { ipcSender, senderWindow } from "../src/main/senders.ts";

const mainFrame = { origin: "eidolon-app://app" };
const mainContents = { mainFrame };
const subframe = { origin: "eidolon-app://app" };
const herFrame = { origin: "eidolon-app://app" };
const herContents = { mainFrame: herFrame };
let her: typeof herContents | null = null;

senderWindow("main", () => mainContents as never);
senderWindow("companion", () => her as never);

/** An IPC event from `sender`'s `frame`. */
const event = (sender: object, frame: object | null) =>
  ({ sender, senderFrame: frame }) as unknown as Parameters<typeof ipcSender>[0];

test("the main window's main frame, and a subframe of it", () => {
  expect(ipcSender(event(mainContents, mainFrame))).toEqual({
    window: "main",
    mainFrame: true,
    origin: "eidolon-app://app",
  });
  expect(ipcSender(event(mainContents, subframe))).toEqual({
    window: "main",
    mainFrame: false,
    origin: "eidolon-app://app",
  });
});

test("the desktop companion's main frame, by her webContents, though her page's origin is the app page's", () => {
  expect(ipcSender(event(herContents, herFrame))).toEqual({
    window: null,
    mainFrame: false,
    origin: "eidolon-app://app",
  });
  her = herContents;
  expect(ipcSender(event(herContents, herFrame))).toEqual({
    window: "companion",
    mainFrame: true,
    origin: "eidolon-app://app",
  });
  // Her frame in the main window's webContents is no main frame of it.
  expect(ipcSender(event(mainContents, herFrame)).mainFrame).toBe(false);
});

test("a webContents no window holds, and a frame that's gone", () => {
  expect(ipcSender(event({ mainFrame: {} }, { origin: "eidolon-app://app" }))).toEqual({
    window: null,
    mainFrame: false,
    origin: "eidolon-app://app",
  });
  expect(ipcSender(event(mainContents, null))).toEqual({
    window: "main",
    mainFrame: false,
    origin: null,
  });
});

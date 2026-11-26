// Windows toastXml formatting: single/group layouts, XML escaping, and file:/// avatar URIs.
import { describe, expect, test } from "vitest";
import { windowsToastXml } from "../src/main/toast-xml.ts";

describe("windowsToastXml", () => {
  test("formats a single-chat or task notice with escaped text and file:// appLogoOverride", () => {
    const avatar =
      process.platform === "win32"
        ? "C:\\Users\\t\\AppData\\avatar & 1.png"
        : "/tmp/avatar & 1.png";
    const xml = windowsToastXml({
      title: "Milky <Green> & Co",
      body: "Line 1\n\"quoted\" & 'single'\u0000",
      sender: { id: "milky-green", name: "Milky Green", avatarPath: avatar },
    });
    expect(xml).not.toContain("<header ");
    expect(xml).toContain("<text>Milky &lt;Green&gt; &amp; Co</text>");
    expect(xml).toContain("<text>Line 1\n&quot;quoted&quot; &amp; &apos;single&apos; </text>");
    expect(xml).toContain('placement="appLogoOverride" src="file:///');
    expect(xml).not.toContain("hint-crop");
    expect(xml).toContain("%20&amp;%201.png");
  });

  test("formats a group notice with <header> grouping, speaker line, and group composite avatar", () => {
    const avatar = process.platform === "win32" ? "C:\\tmp\\group.png" : "/tmp/group.png";
    const xml = windowsToastXml({
      title: "Group <Alpha>",
      subtitle: "Rin",
      body: "Ready!",
      sender: { id: "rin", name: "Rin" },
      group: { id: "chat-uuid", title: "Group <Alpha>", avatarPath: avatar },
    });
    expect(xml).toContain(
      '<header id="chat-uuid" title="Group &lt;Alpha&gt;" arguments="chat-uuid"/>',
    );
    expect(xml).toContain("<text>Rin</text><text>Ready!</text>");
    expect(xml).toContain('placement="appLogoOverride" src="file:///');
    expect(xml).not.toContain("hint-crop");
  });

  test("omits the image element when no avatarPath is given", () => {
    const xml = windowsToastXml({ title: "LAPLACE Eidolon", body: "The task failed" });
    expect(xml).not.toContain("<image ");
    expect(xml).toBe(
      '<toast><visual><binding template="ToastGeneric"><text>LAPLACE Eidolon</text><text>The task failed</text></binding></visual></toast>',
    );
  });
});

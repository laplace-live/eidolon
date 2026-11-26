// Windows ToastGeneric XML builder for DesktopNotice: supports single chats, task notices, and
// group chats (<header> grouping) with pre-cropped 256x256 transparent avatar PNGs.
import { pathToFileURL } from "node:url";
import type { DesktopNotice } from "./background.ts";

// Control characters and noncharacters illegal in XML 1.0 (other than tab, LF, CR).
function stripIllegalXml(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    const valid =
      cp === 0x09 ||
      cp === 0x0a ||
      cp === 0x0d ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      cp >= 0x10000;
    out += valid ? ch : " ";
  }
  return out;
}

function escapeXml(value: string): string {
  return stripIllegalXml(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Builds a Windows ToastGeneric XML payload for `notice`. */
export function windowsToastXml(notice: DesktopNotice): string {
  const avatarPath = notice.group?.avatarPath ?? notice.sender?.avatarPath;
  // hint-crop="none": the backend already masked single avatars and group composites onto transparent PNGs.
  const image =
    avatarPath !== undefined && avatarPath !== ""
      ? `<image placement="appLogoOverride" hint-crop="none" src="${escapeXml(pathToFileURL(avatarPath).href)}"/>`
      : "";
  const header =
    notice.group === undefined
      ? ""
      : `<header id="${escapeXml(notice.group.id)}" title="${escapeXml(notice.group.title)}" arguments="${escapeXml(notice.group.id)}"/>`;
  const heading =
    notice.group === undefined
      ? (notice.title ?? "")
      : (notice.sender?.name ?? notice.subtitle ?? notice.title ?? "");
  const body = notice.body ?? "";
  return `<toast>${header}<visual><binding template="ToastGeneric"><text>${escapeXml(heading)}</text><text>${escapeXml(body)}</text>${image}</binding></visual></toast>`;
}

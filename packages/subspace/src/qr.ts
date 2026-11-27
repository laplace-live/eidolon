import { renderSVG, renderUnicodeCompact } from "uqr";

export function renderPairingQrSvg(pairingUrl: string): string {
  return renderSVG(pairingUrl, {
    ecc: "M",
    border: 2,
    pixelSize: 6,
    whiteColor: "#ffffff",
    blackColor: "#09090b",
  });
}

export function renderPairingQrTerminal(pairingUrl: string): string {
  return renderUnicodeCompact(pairingUrl, { ecc: "L", border: 1 });
}

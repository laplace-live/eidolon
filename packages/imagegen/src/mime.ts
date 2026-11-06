// Python 3.13 `mimetypes` with only its built-in strict table. Python also merges the host's
// mime.types files, which differ between a macOS checkout and the container.

// Extension → type, image types only: all a reference file may be.
const IMAGE_TYPES = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ief", "image/ief"],
  [".jpg", "image/jpeg"],
  [".jpe", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tiff", "image/tiff"],
  [".tif", "image/tiff"],
  [".ico", "image/vnd.microsoft.icon"],
  [".webp", "image/webp"],
  [".ras", "image/x-cmu-raster"],
  [".pnm", "image/x-portable-anymap"],
  [".pbm", "image/x-portable-bitmap"],
  [".pgm", "image/x-portable-graymap"],
  [".ppm", "image/x-portable-pixmap"],
  [".rgb", "image/x-rgb"],
  [".xbm", "image/x-xbitmap"],
  [".xpm", "image/x-xpixmap"],
  [".xwd", "image/x-xwindowdump"],
]);

/** The extensions of the files the selfie tool takes for images, lowercase with the dot. */
export const REFERENCE_EXTENSIONS: readonly string[] = [...IMAGE_TYPES.keys()];

// guess_extension: the first extension the table lists for each type.
const EXTENSIONS = new Map<string, string>([
  ["text/javascript", ".js"],
  ["application/json", ".json"],
  ["application/manifest+json", ".webmanifest"],
  ["application/msword", ".doc"],
  ["application/n-quads", ".nq"],
  ["application/n-triples", ".nt"],
  ["application/octet-stream", ".bin"],
  ["application/oda", ".oda"],
  ["application/pdf", ".pdf"],
  ["application/pkcs7-mime", ".p7c"],
  ["application/postscript", ".ps"],
  ["application/trig", ".trig"],
  ["application/vnd.apple.mpegurl", ".m3u"],
  ["application/vnd.ms-excel", ".xls"],
  ["application/vnd.ms-powerpoint", ".ppt"],
  ["application/wasm", ".wasm"],
  ["application/x-bcpio", ".bcpio"],
  ["application/x-cpio", ".cpio"],
  ["application/x-csh", ".csh"],
  ["application/x-dvi", ".dvi"],
  ["application/x-gtar", ".gtar"],
  ["application/x-hdf", ".hdf"],
  ["application/x-hdf5", ".h5"],
  ["application/x-latex", ".latex"],
  ["application/x-mif", ".mif"],
  ["application/x-netcdf", ".cdf"],
  ["application/x-pkcs12", ".p12"],
  ["application/x-pn-realaudio", ".ram"],
  ["application/x-python-code", ".pyc"],
  ["application/x-sh", ".sh"],
  ["application/x-shar", ".shar"],
  ["application/x-shockwave-flash", ".swf"],
  ["application/x-sv4cpio", ".sv4cpio"],
  ["application/x-sv4crc", ".sv4crc"],
  ["application/x-tar", ".tar"],
  ["application/x-tcl", ".tcl"],
  ["application/x-tex", ".tex"],
  ["application/x-texinfo", ".texi"],
  ["application/x-troff", ".roff"],
  ["application/x-troff-man", ".man"],
  ["application/x-troff-me", ".me"],
  ["application/x-troff-ms", ".ms"],
  ["application/x-ustar", ".ustar"],
  ["application/x-wais-source", ".src"],
  ["application/xml", ".xsl"],
  ["application/zip", ".zip"],
  ["audio/3gpp", ".3gp"],
  ["audio/3gpp2", ".3g2"],
  ["audio/aac", ".aac"],
  ["audio/basic", ".au"],
  ["audio/mpeg", ".mp3"],
  ["audio/opus", ".opus"],
  ["audio/x-aiff", ".aif"],
  ["audio/x-pn-realaudio", ".ra"],
  ["audio/x-wav", ".wav"],
  ["image/avif", ".avif"],
  ["image/bmp", ".bmp"],
  ["image/gif", ".gif"],
  ["image/ief", ".ief"],
  ["image/jpeg", ".jpg"],
  ["image/heic", ".heic"],
  ["image/heif", ".heif"],
  ["image/png", ".png"],
  ["image/svg+xml", ".svg"],
  ["image/tiff", ".tiff"],
  ["image/vnd.microsoft.icon", ".ico"],
  ["image/webp", ".webp"],
  ["image/x-cmu-raster", ".ras"],
  ["image/x-portable-anymap", ".pnm"],
  ["image/x-portable-bitmap", ".pbm"],
  ["image/x-portable-graymap", ".pgm"],
  ["image/x-portable-pixmap", ".ppm"],
  ["image/x-rgb", ".rgb"],
  ["image/x-xbitmap", ".xbm"],
  ["image/x-xpixmap", ".xpm"],
  ["image/x-xwindowdump", ".xwd"],
  ["message/rfc822", ".eml"],
  ["text/css", ".css"],
  ["text/csv", ".csv"],
  ["text/html", ".html"],
  ["text/markdown", ".md"],
  ["text/n3", ".n3"],
  ["text/plain", ".txt"],
  ["text/richtext", ".rtx"],
  ["text/rtf", ".rtf"],
  ["text/tab-separated-values", ".tsv"],
  ["text/vtt", ".vtt"],
  ["text/x-python", ".py"],
  ["text/x-rst", ".rst"],
  ["text/x-setext", ".etx"],
  ["text/x-sgml", ".sgm"],
  ["text/x-vcard", ".vcf"],
  ["text/xml", ".xml"],
  ["video/mp4", ".mp4"],
  ["video/mpeg", ".mpeg"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
  ["video/x-msvideo", ".avi"],
  ["video/x-sgi-movie", ".movie"],
]);

const SUFFIX_MAP = new Map([
  [".svgz", ".svg.gz"],
  [".tgz", ".tar.gz"],
  [".taz", ".tar.gz"],
  [".tz", ".tar.gz"],
  [".tbz2", ".tar.bz2"],
  [".txz", ".tar.xz"],
]);
const ENCODINGS = new Set([".gz", ".Z", ".bz2", ".xz", ".br"]);

/** `os.path.splitext`: a leading run of dots never starts an extension. */
function splitext(path: string): [string, string] {
  const sep = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot > sep) {
    for (let i = sep + 1; i < dot; i++) {
      if (path[i] !== ".") return [path.slice(0, dot), path.slice(dot)];
    }
  }
  return [path, ""];
}

/**
 * `mimetypes.guess_type(fileName)[0]` when it names an image type, else null. Compression
 * suffixes are looked through, so `x.png.gz` is `image/png`.
 */
export function imageMediaType(fileName: string): string | null {
  let [base, ext] = splitext(fileName);
  for (;;) {
    const mapped = SUFFIX_MAP.get(ext.toLowerCase());
    if (mapped === undefined) break;
    [base, ext] = splitext(base + mapped);
  }
  if (ENCODINGS.has(ext)) [, ext] = splitext(base);
  return IMAGE_TYPES.get(ext.toLowerCase()) ?? null;
}

/** The URL and file extension for a media type: `guess_extension` over the same table, else `.png`. */
export function imageSuffix(mediaType: string): string {
  return EXTENSIONS.get(mediaType.toLowerCase()) ?? ".png";
}

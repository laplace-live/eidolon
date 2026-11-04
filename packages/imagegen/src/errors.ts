/** The image API refused, failed, or returned nothing usable, or a reference can't be read. */
export class ImageGenError extends Error {
  override name = "ImageGenError";
}

/** Each persona's picture version as the main window last told it, read on her page. */
export class HeardPictures {
  readonly #heard = new Map<string, number>();

  /**
   * Whether `version` tells of a change to `persona`'s picture since this page last heard of it:
   * the page reuses a picture it loaded under the same URL, so it loads a changed one again only
   * when told. The first word on a persona is no change: the page loads her picture afresh then.
   */
  changed(persona: string, version: number): boolean {
    const before = this.#heard.get(persona);
    this.#heard.set(persona, version);
    return before !== undefined && before !== version;
  }
}

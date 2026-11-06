// The voice dialog's open state, held by the save it starts.

/**
 * Opens or closes the voice dialog, unless a save is in flight: that holds it open with the save's
 * state, which the picker shows. Closing it otherwise drops the last save's outcome.
 */
export function changeVoiceDialog(
  open: boolean,
  saving: boolean,
  setOpen: (open: boolean) => void,
  reset: () => void,
): void {
  if (saving) return;
  setOpen(open);
  if (!open) reset();
}

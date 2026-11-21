# Workaround for electron-builder#6865: on update the stock uninstaller moves installed
# files out one-by-one (un.atomicRMDir) and aborts on the first failure (locked file, long
# path), which the next installer reports as a misleading "cannot be closed" dialog.
!macro customRemoveFiles
  SetOutPath $TEMP  # move cwd out of $INSTDIR so the dir itself can be removed
  RMDir /r $INSTDIR
!macroend

import { envFlag, findDotenv, installSettings, loadDotenv } from "@eidolon/config";

if (!envFlag("EIDOLON_NO_DOTENV", false)) {
  loadDotenv(findDotenv(import.meta.dirname), { override: true });
}
installSettings();

import { notarize } from "@electron/notarize";

export default async function notarizeApp(context) {
  if (context.electronPlatformName !== "darwin") return;
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    if (process.env.CI) throw new Error("Notarization credentials are required in CI");
    return;
  }
  await notarize({
    appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
}

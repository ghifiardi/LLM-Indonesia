import {
  createNestablePublicClientApplication,
  InteractionRequiredAuthError
} from "./vendor/msal-browser/index.mjs";

const CLIENT_ID = "dd3b1cec-a8e1-460f-9312-350cad54a488";

const msalConfig = {
  auth: {
    clientId: CLIENT_ID,
    authority: "https://login.microsoftonline.com/organizations"
  }
};

/*
 * Basic Microsoft 365 sign-in.
 *
 * This is intentionally minimal. Tantular does NOT request access to
 * OneDrive/SharePoint files during normal Office Add-in sign-in.
 */
const loginRequest = {
  scopes: ["User.Read"]
};

/*
 * Requested only by features that explicitly need Microsoft Graph file access,
 * for example browsing/opening/saving files in OneDrive or SharePoint.
 */
const fileRequest = {
  scopes: ["User.Read", "Files.ReadWrite"]
};

let msalInstance = null;

export async function initializeAuth() {
  if (!msalInstance) {
    msalInstance = await createNestablePublicClientApplication(msalConfig);
  }

  return msalInstance;
}

export function getSignedInAccount() {
  if (!msalInstance) return null;

  const accounts = msalInstance.getAllAccounts?.() || [];
  return accounts[0] || null;
}

async function acquireToken(request) {
  const msal = await initializeAuth();

  try {
    return await msal.acquireTokenSilent(request);
  } catch (error) {
    if (
      error instanceof InteractionRequiredAuthError ||
      error?.name === "InteractionRequiredAuthError"
    ) {
      return await msal.acquireTokenPopup(request);
    }

    throw error;
  }
}

/*
 * Normal Tantular sign-in.
 * Only asks Microsoft for basic user identity.
 */
export async function signIn() {
  const result = await acquireToken(loginRequest);
  return result?.account || null;
}

/*
 * Basic Microsoft Graph token.
 * Useful for profile-level Graph calls and does NOT request file access.
 */
export async function getGraphAccessToken() {
  const result = await acquireToken(loginRequest);

  if (!result?.accessToken) {
    throw new Error("Microsoft Graph access token tidak tersedia.");
  }

  return result.accessToken;
}

/*
 * OneDrive / SharePoint file access.
 *
 * Call this ONLY when the user explicitly chooses a feature that needs
 * Microsoft 365 file access. This is where Files.ReadWrite consent happens.
 */
export async function getGraphFileAccessToken() {
  const result = await acquireToken(fileRequest);

  if (!result?.accessToken) {
    throw new Error("Microsoft 365 file access token tidak tersedia.");
  }

  return result.accessToken;
}

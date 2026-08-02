import type { AccountProfile } from '../types';

export const NO_TOKEN_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const TOKEN_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export function uploadLimitForProfile(profile: AccountProfile): number {
  return profile.token_configured ? TOKEN_MAX_UPLOAD_BYTES : NO_TOKEN_MAX_UPLOAD_BYTES;
}

export function prioritizeUploadProfiles(
  profiles: AccountProfile[],
  primaryAccountName: string,
  failoverEnabled: boolean,
  fileSize: number,
): AccountProfile[] {
  const primary = profiles.find((profile) => profile.account_name === primaryAccountName);
  if (!primary) return [];
  if (!failoverEnabled || fileSize > NO_TOKEN_MAX_UPLOAD_BYTES) return [primary];

  const children = profiles.filter(
    (profile) => profile.account_name !== primaryAccountName && profile.credential_configured,
  );
  return [...children, primary];
}

export function nextHourlyResetTimestamp(now = Date.now()): number {
  const hour = 60 * 60 * 1000;
  return Math.floor(now / hour) * hour + hour + 1_000;
}

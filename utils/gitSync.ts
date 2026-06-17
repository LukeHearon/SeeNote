export function normalizeGitRemoteUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.endsWith('.git') ? trimmed : `${trimmed}.git`;
}

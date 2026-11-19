import path from 'node:path';
import { config, displayPathFor } from './config.js';
import { atomicWriteJson, normalizeTwitchLogin, readJson } from './util.js';

function settingsFile() {
  return path.join(config.dataDir, 'settings.json');
}

export function loadSettings() {
  return readJson(settingsFile(), null);
}

export function isInsideVideosRoot(input) {
  const resolved = path.resolve(input || config.videosRoot);
  return resolved === config.videosRoot
    || resolved.startsWith(`${config.videosRoot}${path.sep}`);
}

export function validateDestination(input) {
  const resolved = path.resolve(input || config.videosRoot);
  if (!isInsideVideosRoot(resolved)) {
    throw new Error(`Destination folder must be inside ${config.videosRoot}`);
  }
  return resolved;
}

export function settingsFromConfig() {
  return {
    appName: config.appName,
    appMark: config.appMark,
    filenameTemplate: config.filenameTemplate,
    twitch: {
      enabled: config.twitch.enabled,
      channel: config.twitch.channelInput || config.twitch.login,
      resolved: config.twitch.login,
    },
    youtube: {
      enabled: config.youtube.enabled,
      channel: config.youtube.channelInput || config.youtube.channelId,
      label: config.youtube.channelLabel,
      resolved: config.youtube.channelId,
    },
    destination: {
      dir: config.recordingsDir,
      display: config.archiveDisplayPath,
      root: config.videosRoot,
      hostRoot: config.videosHostRoot,
    },
  };
}

/**
 * Apply persisted UI settings onto the mutable runtime config. Destination is
 * validated against VIDEOS_ROOT so the dashboard cannot write outside the
 * mounted folder.
 */
export function applySettingsToConfig(settings) {
  if (!settings || typeof settings !== 'object') return false;
  if (typeof settings.appName === 'string' && settings.appName.trim()) {
    config.appName = settings.appName.trim().slice(0, 80);
  }
  if (typeof settings.appMark === 'string' && settings.appMark.trim()) {
    config.appMark = settings.appMark.trim().slice(0, 4);
  }
  if (typeof settings.filenameTemplate === 'string' && settings.filenameTemplate.trim()) {
    config.filenameTemplate = settings.filenameTemplate.trim().slice(0, 200);
  }
  if (settings.twitch && typeof settings.twitch === 'object') {
    config.twitch.enabled = settings.twitch.enabled !== false;
    const channel = String(settings.twitch.channel || '').trim();
    if (channel) {
      config.twitch.channelInput = channel;
      config.twitch.login = normalizeTwitchLogin(channel);
    }
  }
  if (settings.youtube && typeof settings.youtube === 'object') {
    config.youtube.enabled = settings.youtube.enabled !== false;
    const channel = String(settings.youtube.channel || '').trim();
    if (channel) {
      config.youtube.channelInput = channel;
      config.youtube.channelId = /^UC[\w-]{22}$/.test(channel) ? channel : '';
    }
    if (typeof settings.youtube.label === 'string') {
      config.youtube.channelLabel = settings.youtube.label.trim().slice(0, 80);
    }
  }
  if (settings.destination?.dir) {
    const dir = validateDestination(settings.destination.dir);
    config.recordingsDir = dir;
    config.archiveDisplayPath = settings.destination.display || displayPathFor(dir);
    config.archiveMetaDir = path.join(dir, '.stream-vod-guard');
  }
  return true;
}

export async function saveSettings(settings) {
  await atomicWriteJson(settingsFile(), settings);
}

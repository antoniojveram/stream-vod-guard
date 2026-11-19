import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, ensureDirs } from './config.js';
import { logger } from './logger.js';
import { Store } from './store.js';
import { Archiver, Monitors } from './monitor.js';
import { createApiServer } from './api.js';
import { loadSettings, applySettingsToConfig } from './settings.js';
import { humanBytes, run, truncate } from './util.js';
import { resolveYouTubeChannelId } from './youtube.js';

async function checkTools() {
  const tools = [
    { name: 'ffmpeg', args: ['-version'] },
    { name: 'ffprobe', args: ['-version'] },
    { name: 'streamlink', args: ['--version'] },
    { name: 'yt-dlp', args: ['--version'] },
  ];
  const versions = {};
  for (const tool of tools) {
    const result = await run(tool.name, tool.args, { timeoutMs: 20000, maxOutput: 4096 });
    if (result.code !== 0) {
      throw new Error(`Missing required tool: ${tool.name}. ${truncate(result.stderr, 300)}`);
    }
    versions[tool.name] = result.stdout.split('\n')[0].trim();
  }
  return versions;
}

async function checkWritable(dir) {
  const testFile = path.join(dir, `.write-test-${process.pid}`);
  await fsp.writeFile(testFile, 'ok');
  await fsp.rm(testFile, { force: true });
}

async function resolveChannels() {
  if (config.twitch.enabled && !config.twitch.login) {
    config.twitch.enabled = false;
    logger.error('TWITCH_CHANNEL is empty; Twitch monitor disabled. Set it in .env or the dashboard.');
  }
  logger.info('Channels configured', {
    twitch: config.twitch.enabled ? config.twitch.login : 'disabled',
    youtubeInput: config.youtube.enabled ? config.youtube.channelInput : 'disabled',
  });
  if (!config.youtube.enabled) return;
  if (!config.youtube.channelInput) {
    config.youtube.enabled = false;
    logger.error('YOUTUBE_CHANNEL is empty; YouTube monitor disabled. Set it in .env or the dashboard.');
    return;
  }
  try {
    const resolved = await resolveYouTubeChannelId(config.youtube.channelInput);
    config.youtube.channelId = resolved.id;
    config.youtube.channelLabel = config.youtube.channelLabel || resolved.label || resolved.id;
    logger.info('YouTube channel resolved', {
      id: resolved.id,
      label: config.youtube.channelLabel,
      source: resolved.source,
    });
  } catch (error) {
    config.youtube.enabled = false;
    logger.error(`Could not resolve YouTube channel: ${error.message}`);
    logger.warn('YouTube monitor disabled; fix YOUTUBE_CHANNEL in the dashboard or .env.');
  }
}

async function main() {
  ensureDirs();
  const persisted = loadSettings();
  if (persisted) {
    try {
      applySettingsToConfig(persisted);
      logger.info('Persisted UI settings applied', {
        destination: config.archiveDisplayPath,
        twitch: config.twitch.channelInput,
        youtube: config.youtube.channelInput,
      });
    } catch (error) {
      logger.error(`Invalid persisted settings ignored: ${error.message}`);
    }
  }
  ensureDirs();
  await checkWritable(config.dataDir);
  await checkWritable(config.workDir);

  const versions = await checkTools();
  logger.info(`Starting ${config.appName}`, versions);
  logger.info('Recording destinations', {
    final: config.archiveDisplayPath,
    containerPath: config.recordingsDir,
    work: config.workDir,
    state: config.stateFile,
  });

  try {
    await checkWritable(config.recordingsDir);
    logger.info('Destination directory is writable');
  } catch (error) {
    logger.error(`Destination directory is NOT writable: ${error.message}`);
    // Keep running: recordings stay on local disk and archive retries later.
  }

  const store = await new Store(config.stateFile).init();
  const archiver = new Archiver(store);
  await resolveChannels();
  const monitors = new Monitors(archiver);
  const server = createApiServer({ store, archiver, monitors });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  logger.info(`Dashboard: http://${config.host}:${config.port}`);

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down`);
    const force = setTimeout(() => {
      logger.warn('Forced exit');
      process.exit(1);
    }, 30000);
    force.unref();
    try {
      await monitors.stop();
      await archiver.shutdown();
      await new Promise((resolve) => {
        server.close(resolve);
        setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, 3000).unref();
      });
      await store.flush();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error(`Shutdown error: ${error.message}`);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason?.message || reason}`);
  });
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception: ${error.stack || error.message}`);
    void shutdown('uncaughtException');
  });

  await monitors.start();
  let localFree = 0;
  try {
    const stats = await fsp.statfs(config.workDir);
    localFree = Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // ignore
  }
  logger.info('Monitors running', {
    twitch: config.twitch.enabled ? `https://twitch.tv/${config.twitch.login}` : 'disabled',
    youtube: config.youtube.enabled ? `https://youtube.com/channel/${config.youtube.channelId}` : 'disabled',
    localFree: humanBytes(localFree),
  });

  // Keep the process alive; the monitor loops themselves are timers.
  await new Promise(() => {});
}

main().catch((error) => {
  logger.error(`Fatal startup error: ${error.stack || error.message}`);
  process.exit(1);
});

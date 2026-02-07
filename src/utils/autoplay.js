const { spawn } = require('child_process');
const { YT_DLP_COMMAND } = require('../config');
const { getSongInfo } = require('./search');
const logger = require('../logger');

async function getAutoplaySongs(videoId, limit = 12) {
    console.log(`[AUTOPLAY] Fetching autoplay for video: ${videoId}`);
    logger.info(`[AUTOPLAY] Fetching autoplay for video: ${videoId}`);
    const p = spawn(YT_DLP_COMMAND, [
        '--dump-json',
        '--flat-playlist',
        '--playlist-end', String(limit + 1),
        '--no-warnings',
        `https://music.youtube.com/watch?v=${videoId}&list=RD${videoId}`
    ]);

    let data = '';
    p.stdout.on('data', c => data += c);

    return new Promise(resolve => {
        p.on('close', async () => {
            try {
                const lines = data.trim().split('\n');
                const songs = [];
                for (let i = 1; i < lines.length; i++) {
                    const r = JSON.parse(lines[i]);
                    const info = await getSongInfo(`https://music.youtube.com/watch?v=${r.id}`);
                    if (info) songs.push(info);
                }
                console.log(`[AUTOPLAY] Fetched ${songs.length} songs`);
                logger.info(`[AUTOPLAY] Fetched ${songs.length} songs`);
                resolve(songs);
            } catch {
                resolve([]);
            }
        });
    });
}

module.exports = { getAutoplaySongs };
